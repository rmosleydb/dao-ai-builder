"""
DAO AI Builder - Databricks App Entry Point

This is the main entry point for deploying as a Databricks App.
It serves the React frontend and provides API endpoints for Databricks integration.

Authentication:
- Primary: OAuth2 Authorization Code flow with Databricks
- Fallback 1: X-Forwarded-Access-Token header (Databricks App OBO auth)
- Fallback 2: Databricks SDK Config for local development
- Reference: https://apps-cookbook.dev/docs/streamlit/authentication/users_obo

Deployment:
- Run: databricks apps deploy dao-ai-builder --source-code-path .
"""
import os
import sys
import json
import secrets
import logging
import threading
import urllib.parse
from datetime import datetime
from pathlib import Path
from functools import lru_cache

import requests as http_requests
from flask import Flask, send_from_directory, jsonify, request, Response, redirect, session, url_for

# Configure logging to write to stderr (captured by Databricks Apps)
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s [%(levelname)s] %(name)s: %(message)s',
    handlers=[
        logging.StreamHandler(sys.stderr)
    ]
)
logger = logging.getLogger('dao-ai-builder')
logger.setLevel(logging.DEBUG)  # More verbose for debugging

app = Flask(__name__, static_folder='static')

# Also configure Flask's logger to use our handler
app.logger.handlers = []
app.logger.addHandler(logging.StreamHandler(sys.stderr))
app.logger.setLevel(logging.DEBUG)

def log(level: str, msg: str):
    """Write log to stderr and flush immediately for Databricks logs"""
    print(f"[{level.upper()}] {msg}", file=sys.stderr, flush=True)
    if level == 'debug':
        logger.debug(msg)
    elif level == 'info':
        logger.info(msg)
    elif level == 'warning':
        logger.warning(msg)
    elif level == 'error':
        logger.error(msg)

# Log startup
log('info', "DAO AI Builder starting up...")
log('info', f"Python version: {sys.version}")
log('info', f"Working directory: {os.getcwd()}")

# Secret key for session management
# Use a stable key from environment or generate a stable one based on hostname
# This ensures sessions persist across app restarts
default_secret = os.environ.get('DATABRICKS_HOST', 'dao-ai-builder') + '-session-key'
app.secret_key = os.environ.get('FLASK_SECRET_KEY', default_secret)

# Configure session cookies for proper handling in incognito mode and HTTPS
# SameSite=Lax allows cookies to be sent on top-level navigations (OAuth redirects)
# Secure=True when running over HTTPS (detected from environment)
is_https = os.environ.get('HTTPS', 'false').lower() == 'true' or \
           os.environ.get('DATABRICKS_HOST', '').startswith('https')
app.config.update(
    SESSION_COOKIE_SAMESITE='Lax',  # Allow cookies on OAuth redirects
    SESSION_COOKIE_SECURE=is_https,  # Secure in HTTPS environments
    SESSION_COOKIE_HTTPONLY=True,    # Prevent XSS access to session cookie
    SESSION_COOKIE_NAME='dao_session',  # Custom name to avoid conflicts
    PERMANENT_SESSION_LIFETIME=3600,  # 1 hour session lifetime
)
log('info', f"Session configured: SameSite=Lax, Secure={is_https}")

# Static folder path - defaults to 'static' in the same directory as this file
STATIC_FOLDER = os.environ.get('STATIC_FOLDER', 'static')
if not os.path.isabs(STATIC_FOLDER):
    STATIC_FOLDER = os.path.join(os.path.dirname(__file__), STATIC_FOLDER)

# OAuth2 configuration
# These are populated from environment or app configuration
OAUTH_CLIENT_ID = os.environ.get('OAUTH_CLIENT_ID')
OAUTH_CLIENT_SECRET = os.environ.get('OAUTH_CLIENT_SECRET')

# API Scopes to request during OAuth
# Keep in sync with user_api_scopes in databricks.yml
OAUTH_SCOPES = [
    'sql',
    'dashboards.genie',
    'files.files',
    'serving.serving-endpoints',
    'vectorsearch.vector-search-indexes',
    'vectorsearch.vector-search-endpoints',
    'catalog.connections',
    'catalog.catalogs:read',
    'catalog.schemas:read',
    'catalog.tables:read',
    'offline_access',  # For refresh tokens
]


# Cache the SDK config to avoid repeated lookups
@lru_cache(maxsize=1)
def get_sdk_config():
    """
    Get Databricks SDK Config object.
    This handles authentication from various sources:
    - Environment variables (DATABRICKS_HOST, DATABRICKS_TOKEN)
    - ~/.databrickscfg profile
    - Azure CLI / Service Principal
    - etc.
    """
    try:
        from databricks.sdk.config import Config
        return Config()
    except Exception as e:
        log('warning', f"Could not initialize Databricks SDK Config: {e}")
        return None


def normalize_host(host: str) -> str:
    """Ensure host has https:// scheme."""
    if not host:
        return host
    host = host.strip().rstrip('/')
    if not host.startswith('http://') and not host.startswith('https://'):
        host = f'https://{host}'
    return host


def is_databricks_app_url(host: str) -> bool:
    """
    Check if a host URL is a Databricks Apps URL (not a workspace URL).
    
    Databricks Apps URLs look like:
    - Azure: {app-name}-{workspace-id}.{region}.azure.databricksapps.com
    - AWS: {app-name}-{workspace-id}.aws.databricksapps.com
    - GCP: {app-name}-{workspace-id}.gcp.databricksapps.com
    
    Workspace URLs look like:
    - Azure: adb-{workspace-id}.{region}.azuredatabricks.net
    - AWS: {something}.cloud.databricks.com or regional variants
    - GCP: {workspace-id}.{region}.gcp.databricks.com
    """
    if not host:
        return False
    return 'databricksapps.com' in host.lower()


def get_databricks_host_from_sdk() -> str | None:
    """Get host from Databricks SDK Config."""
    sdk_config = get_sdk_config()
    if sdk_config and sdk_config.host:
        return normalize_host(sdk_config.host)
    return None


def get_databricks_host() -> str | None:
    """Get the Databricks workspace host URL."""
    host, _ = get_databricks_host_with_source()
    return host


def get_databricks_token_from_sdk() -> str | None:
    """Get token from Databricks SDK Config."""
    sdk_config = get_sdk_config()
    if sdk_config:
        try:
            # The SDK Config can provide tokens from various auth methods
            # This will return None if no auth is configured
            if sdk_config.token:
                return sdk_config.token
        except Exception:
            pass
    return None


def get_databricks_token_with_source() -> tuple[str | None, str | None]:
    """
    Get the Databricks authentication token and its source.
    
    For Databricks Apps with User Authorization:
    - Use X-Forwarded-Access-Token header to access APIs on behalf of the user
    - Reference: https://learn.microsoft.com/en-us/azure/databricks/dev-tools/databricks-apps/auth#user-authorization
    
    Resolution order:
    1. Session token (from OAuth flow)
    2. Authorization header Bearer token (explicit from frontend - user's PAT)
    3. X-Forwarded-Access-Token header (Databricks App on-behalf-of-user auth)
    4. Databricks SDK Config (handles env vars, profiles, etc.)
    5. DATABRICKS_TOKEN environment variable (explicit fallback)
    
    Returns:
        tuple: (token, source) where source is one of:
            - 'oauth': OAuth access token from session
            - 'manual': Authorization header from frontend
            - 'obo': X-Forwarded-Access-Token header (Databricks App)
            - 'sdk': Databricks SDK Config
            - 'env': DATABRICKS_TOKEN environment variable
            - None: No token found
    """
    # Try session token first (OAuth flow)
    if 'access_token' in session:
        return session['access_token'], 'oauth'
    
    # Try Authorization header (user's explicit token)
    auth_header = request.headers.get('Authorization', '')
    if auth_header.startswith('Bearer '):
        return auth_header[7:], 'manual'
    
    # Try forwarded header (Databricks App on-behalf-of-user)
    # Per Microsoft docs: https://learn.microsoft.com/en-us/azure/databricks/dev-tools/databricks-apps/auth#user-authorization
    # The x-forwarded-access-token header contains the user's OAuth token
    token = request.headers.get('X-Forwarded-Access-Token')
    if not token:
        # Try lowercase version as some proxies normalize headers
        token = request.headers.get('x-forwarded-access-token')
    if token:
        return token, 'obo'
    
    # Try Databricks SDK Config
    token = get_databricks_token_from_sdk()
    if token:
        return token, 'sdk'
    
    # Explicit fallback to environment variable
    token = os.environ.get('DATABRICKS_TOKEN')
    if token:
        return token, 'env'
    
    return None, None


def get_databricks_token() -> str | None:
    """Get the Databricks authentication token."""
    token, _ = get_databricks_token_with_source()
    return token


def get_databricks_host_with_source() -> tuple[str | None, str | None]:
    """
    Get the Databricks workspace host URL and its source.
    
    Resolution order:
    1. Session host (from OAuth flow)
    2. X-Databricks-Host header (sent by frontend for manual config)
    3. Databricks SDK Config (handles env vars, profiles, etc.)
    4. DATABRICKS_HOST environment variable (explicit fallback)
    
    Note: We do NOT use X-Forwarded-Host header because it contains the APP URL
    (e.g., dao-ai-builder-xxx.aws.databricksapps.com), not the workspace URL.
    The workspace URL is correctly set in DATABRICKS_HOST by Databricks Apps
    on both Azure and AWS.
    
    Returns:
        tuple: (host, source) where source is one of:
            - 'oauth': From OAuth session
            - 'header': X-Databricks-Host header from frontend
            - 'sdk': Databricks SDK Config
            - 'env': DATABRICKS_HOST environment variable
            - None: No host found
    """
    # Check session first (OAuth flow)
    if 'databricks_host' in session:
        return session['databricks_host'], 'oauth'
    
    # Check header (for manual configuration from frontend)
    host = request.headers.get('X-Databricks-Host')
    if host:
        return normalize_host(host), 'header'
    
    # Use DATABRICKS_HOST environment variable (set by Databricks Apps infrastructure)
    # This is the simplest and most reliable approach - Databricks Apps correctly sets
    # DATABRICKS_HOST to the workspace URL on both Azure and AWS.
    #
    # Note: X-Forwarded-Host contains the APP URL (not workspace URL), so we don't use it.
    # The app URL is available in DATABRICKS_APP_URL if needed.
    
    # Try Databricks SDK Config (reads from DATABRICKS_HOST and other sources)
    host = get_databricks_host_from_sdk()
    if host:
        return host, 'sdk'
    
    # Direct fallback to DATABRICKS_HOST environment variable
    host = os.environ.get('DATABRICKS_HOST')
    if host:
        return normalize_host(host), 'env'
    
    return None, None


# =============================================================================
# OAuth2 Endpoints
# =============================================================================

@app.route('/api/auth/login')
def oauth_login():
    """
    Initiate OAuth2 Authorization Code flow.
    Redirects user to Databricks to approve scopes.
    """
    # Get the host for OAuth
    host = request.args.get('host')
    if not host:
        host, _ = get_databricks_host_with_source()
    
    if not host:
        return jsonify({
            'error': 'No Databricks host configured',
            'message': 'Please provide a host parameter or configure DATABRICKS_HOST'
        }), 400
    
    host = normalize_host(host)
    
    # Get OAuth client credentials
    # In Databricks Apps, these are available from the app configuration
    client_id = OAUTH_CLIENT_ID or os.environ.get('DATABRICKS_OAUTH_CLIENT_ID')
    
    # For Databricks Apps, we can use the app's service principal
    # The client_id is available in the app environment
    if not client_id:
        # Try to get from Databricks App context
        # When running as a Databricks App, the app's OAuth client ID is available
        app_client_id = os.environ.get('DATABRICKS_APP_CLIENT_ID')
        if app_client_id:
            client_id = app_client_id
    
    if not client_id:
        return jsonify({
            'error': 'OAuth not configured',
            'message': 'No OAuth client ID available. Configure OAUTH_CLIENT_ID or use Databricks App deployment.',
            'oauth_required': True,
            'host': host,
        }), 400
    
    # Generate state for CSRF protection
    state = secrets.token_urlsafe(32)
    
    # Make session permanent for better cookie persistence
    session.permanent = True
    session['oauth_state'] = state
    session['oauth_host'] = host
    
    log('info', f"OAuth login initiated. State stored in session. Host: {host}")
    
    # Build authorization URL
    # Databricks uses standard OIDC endpoints
    auth_endpoint = f"{host}/oidc/v1/authorize"
    
    # Get the callback URL
    callback_url = url_for('oauth_callback', _external=True)
    
    # Build the authorization URL
    params = {
        'client_id': client_id,
        'response_type': 'code',
        'redirect_uri': callback_url,
        'scope': ' '.join(OAUTH_SCOPES),
        'state': state,
    }
    
    auth_url = f"{auth_endpoint}?{urllib.parse.urlencode(params)}"
    
    log('info', f"Redirecting to OAuth: {auth_endpoint}")
    
    return jsonify({
        'auth_url': auth_url,
        'redirect': True,
    })


@app.route('/api/auth/callback')
def oauth_callback():
    """
    Handle OAuth2 callback with authorization code.
    Exchange code for access token.
    """
    log('info', f"OAuth callback received. Session keys: {list(session.keys())}")
    
    # Verify state
    state = request.args.get('state')
    stored_state = session.get('oauth_state')
    
    if not stored_state:
        log('error', "OAuth state not found in session - session may have expired or cookies not set")
        # Return a user-friendly HTML page instead of JSON for better UX
        return '''
        <!DOCTYPE html>
        <html>
        <head><title>Session Error</title></head>
        <body style="font-family: sans-serif; padding: 40px; text-align: center;">
            <h1>Session Expired</h1>
            <p>Your session has expired or cookies are not enabled.</p>
            <p>Please ensure cookies are enabled in your browser and try again.</p>
            <p><a href="/" style="color: #0066cc;">Return to Application</a></p>
            <p style="color: #666; font-size: 12px; margin-top: 40px;">
                If you're using incognito mode, make sure third-party cookies are allowed.
            </p>
        </body>
        </html>
        ''', 400
    
    if state != stored_state:
        log('error', f"OAuth state mismatch. Expected: {stored_state[:10]}..., Got: {state[:10] if state else 'None'}...")
        return '''
        <!DOCTYPE html>
        <html>
        <head><title>Security Error</title></head>
        <body style="font-family: sans-serif; padding: 40px; text-align: center;">
            <h1>Security Verification Failed</h1>
            <p>The OAuth state parameter does not match. This could be a security issue.</p>
            <p><a href="/" style="color: #0066cc;">Please try logging in again</a></p>
        </body>
        </html>
        ''', 400
    
    # Check for errors from OAuth provider
    error = request.args.get('error')
    if error:
        error_description = request.args.get('error_description', 'Unknown error')
        log('error', f"OAuth error from provider: {error} - {error_description}")
        return f'''
        <!DOCTYPE html>
        <html>
        <head><title>Authentication Error</title></head>
        <body style="font-family: sans-serif; padding: 40px; text-align: center;">
            <h1>Authentication Error</h1>
            <p><strong>{error}</strong></p>
            <p>{error_description}</p>
            <p><a href="/" style="color: #0066cc;">Return to Application</a></p>
        </body>
        </html>
        ''', 400
    
    # Get authorization code
    code = request.args.get('code')
    if not code:
        log('error', "No authorization code in callback")
        return jsonify({'error': 'No authorization code received'}), 400
    
    # Get host from session
    host = session.get('oauth_host')
    if not host:
        log('error', "OAuth host not found in session")
        return '''
        <!DOCTYPE html>
        <html>
        <head><title>Session Error</title></head>
        <body style="font-family: sans-serif; padding: 40px; text-align: center;">
            <h1>Session Expired</h1>
            <p>The OAuth session has expired. Please try logging in again.</p>
            <p><a href="/" style="color: #0066cc;">Return to Application</a></p>
        </body>
        </html>
        ''', 400
    
    # Get OAuth credentials
    client_id = OAUTH_CLIENT_ID or os.environ.get('DATABRICKS_OAUTH_CLIENT_ID') or os.environ.get('DATABRICKS_APP_CLIENT_ID')
    client_secret = OAUTH_CLIENT_SECRET or os.environ.get('DATABRICKS_OAUTH_CLIENT_SECRET')
    
    # Exchange code for token
    token_endpoint = f"{host}/oidc/v1/token"
    callback_url = url_for('oauth_callback', _external=True)
    
    token_data = {
        'grant_type': 'authorization_code',
        'code': code,
        'redirect_uri': callback_url,
        'client_id': client_id,
    }
    
    if client_secret:
        token_data['client_secret'] = client_secret
    
    try:
        response = http_requests.post(
            token_endpoint,
            data=token_data,
            headers={'Content-Type': 'application/x-www-form-urlencoded'},
            timeout=30,
        )
        
        if response.ok:
            token_response = response.json()
            
            # Store tokens in session
            session['access_token'] = token_response.get('access_token')
            session['refresh_token'] = token_response.get('refresh_token')
            session['token_expires_in'] = token_response.get('expires_in')
            session['databricks_host'] = host
            
            # Clear OAuth state
            session.pop('oauth_state', None)
            session.pop('oauth_host', None)
            
            log('info', "OAuth token exchange successful")
            
            # Redirect back to the app
            return redirect('/')
        else:
            error_data = response.json() if response.headers.get('Content-Type', '').startswith('application/json') else {}
            return jsonify({
                'error': 'Token exchange failed',
                'message': error_data.get('error_description', response.text),
            }), 400
            
    except Exception as e:
        log('error', f"OAuth token exchange error: {e}")
        return jsonify({
            'error': 'Token exchange failed',
            'message': str(e)
        }), 500


@app.route('/api/auth/logout')
def oauth_logout():
    """Clear OAuth session and log out."""
    session.clear()
    return jsonify({'success': True, 'message': 'Logged out'})


@app.route('/api/auth/status')
def oauth_status():
    """Get current OAuth authentication status."""
    has_oauth = 'access_token' in session
    
    return jsonify({
        'authenticated': has_oauth,
        'method': 'oauth' if has_oauth else None,
        'host': session.get('databricks_host'),
        'scopes': OAUTH_SCOPES if has_oauth else None,
    })


# =============================================================================
# Auth Context Endpoint
# =============================================================================

@app.route('/api/auth/context')
def get_auth_context():
    """
    Get authentication context for Databricks API calls.
    
    This endpoint detects the authentication method and returns workspace info,
    including the source of both the host and token.
    """
    # Check for Databricks App headers
    email = request.headers.get('X-Forwarded-Email')
    username = request.headers.get('X-Forwarded-Preferred-Username')
    user_id = request.headers.get('X-Forwarded-User')
    real_ip = request.headers.get('X-Real-Ip')
    
    # Determine if we're in a Databricks App context
    has_obo_token = bool(request.headers.get('X-Forwarded-Access-Token'))
    is_databricks_app = bool(email or username or user_id or has_obo_token)
    
    # Check OAuth status
    has_oauth = 'access_token' in session
    
    # Get host and token with their sources
    host, host_source = get_databricks_host_with_source()
    token, token_source = get_databricks_token_with_source()
    
    has_token = token is not None
    auth_method = token_source or 'manual'
    
    # OAuth configuration info
    oauth_configured = bool(OAUTH_CLIENT_ID or os.environ.get('DATABRICKS_OAUTH_CLIENT_ID') or os.environ.get('DATABRICKS_APP_CLIENT_ID'))
    
    # Check for service principal credentials
    has_service_principal = bool(
        os.environ.get('DATABRICKS_CLIENT_ID') and 
        os.environ.get('DATABRICKS_CLIENT_SECRET')
    )
    
    log('info', f"Auth context: host={host} (from {host_source}), token_source={token_source}, has_token={has_token}, is_app={is_databricks_app}, has_sp={has_service_principal}")
    
    return jsonify({
        'is_databricks_app': is_databricks_app,
        'has_token': has_token,
        'has_obo_token': has_obo_token,
        'has_service_principal': has_service_principal,
        'user': {
            'email': email,
            'username': username,
            'user_id': user_id,
            'ip': real_ip,
        } if is_databricks_app else None,
        'host': host,
        'host_source': host_source,
        'auth_method': auth_method,
        'token_source': token_source,
        'oauth': {
            'configured': oauth_configured,
            'authenticated': has_oauth,
            'scopes': OAUTH_SCOPES,
        },
    })


@app.route('/api/auth/token')
def get_auth_token():
    """
    Legacy endpoint - returns token info.
    Prefer using /api/auth/context for new code.
    """
    token = request.headers.get('X-Forwarded-Access-Token')
    source = 'obo' if token else None
    
    if not token:
        token = os.environ.get('DATABRICKS_TOKEN')
        source = 'env' if token else None
    
    host = os.environ.get('DATABRICKS_HOST')
    email = request.headers.get('X-Forwarded-Email')
    user = request.headers.get('X-Forwarded-User')
    
    return jsonify({
        'token': token,
        'host': host,
        'email': email,
        'user': user,
        'source': source,
    })


@app.route('/api/auth/debug')
def get_auth_debug():
    """
    Debug endpoint to show all Databricks-related environment variables and headers.
    Useful for diagnosing AWS vs Azure differences.
    """
    # Collect relevant environment variables
    env_vars = {}
    for key in ['DATABRICKS_HOST', 'DATABRICKS_WORKSPACE_URL', 'DATABRICKS_WORKSPACE_ID', 
                'DATABRICKS_TOKEN', 'DATABRICKS_CLIENT_ID', 'DATABRICKS_CLIENT_SECRET',
                'DATABRICKS_OAUTH_CLIENT_ID', 'DATABRICKS_APP_CLIENT_ID']:
        value = os.environ.get(key)
        if value:
            # Mask sensitive values
            if 'TOKEN' in key or 'SECRET' in key:
                env_vars[key] = f"***{value[-4:]}" if len(value) > 4 else "***"
            elif 'CLIENT_ID' in key:
                env_vars[key] = f"{value[:8]}..." if len(value) > 8 else value
            else:
                env_vars[key] = value
        else:
            env_vars[key] = None
    
    # Collect relevant headers
    headers = {}
    for key in ['X-Forwarded-Host', 'X-Forwarded-Access-Token', 'X-Forwarded-Email',
                'X-Forwarded-User', 'X-Forwarded-Preferred-Username', 'X-Real-Ip',
                'X-Databricks-Host', 'Host', 'Origin', 'Referer']:
        value = request.headers.get(key)
        if value:
            # Mask sensitive values
            if 'Token' in key:
                headers[key] = f"***{value[-4:]}" if len(value) > 4 else "***"
            else:
                headers[key] = value
        else:
            headers[key] = None
    
    # Get resolved host and source
    host, host_source = get_databricks_host_with_source()
    
    # Check if host looks like an app URL
    is_app_url = is_databricks_app_url(host) if host else False
    
    return jsonify({
        'environment_variables': env_vars,
        'request_headers': headers,
        'resolved': {
            'host': host,
            'host_source': host_source,
            'is_app_url': is_app_url,
        },
        'help': {
            'message': 'If DATABRICKS_HOST contains an app URL (databricksapps.com), '
                      'set DATABRICKS_WORKSPACE_URL to your workspace URL instead.',
            'azure_note': 'On Azure, workspace URL is derived from app URL automatically.',
            'aws_note': 'On AWS, set DATABRICKS_WORKSPACE_URL to your workspace URL '
                       '(e.g., https://dbc-xxxxx.cloud.databricks.com)',
        }
    })


# =============================================================================
# Databricks API Proxy
# =============================================================================

@app.route('/api/databricks/<path:path>', methods=['GET', 'POST', 'PUT', 'DELETE', 'PATCH'])
def proxy_databricks(path: str):
    """
    Proxy requests to Databricks API.
    
    This allows the frontend to make API calls without CORS issues.
    All requests are authenticated using the user's token.
    
    Token priority:
    1. Authorization header from frontend (manual PAT) - ALWAYS used if present
    2. X-Forwarded-Access-Token (OBO) - only if no Authorization header
    """
    # Log all relevant headers for debugging
    log('debug', f"=== PROXY REQUEST: {request.method} {path} ===")
    log('debug', f"Headers: Authorization={request.headers.get('Authorization', 'NONE')[:30] if request.headers.get('Authorization') else 'NONE'}..., X-Databricks-Host={request.headers.get('X-Databricks-Host', 'NONE')}, X-Forwarded-Access-Token={request.headers.get('X-Forwarded-Access-Token', 'NONE')[:20] if request.headers.get('X-Forwarded-Access-Token') else 'NONE'}...")
    
    # Check for explicit Authorization header FIRST (user's manual PAT)
    # This takes absolute priority over OBO token
    auth_header = request.headers.get('Authorization', '')
    if auth_header.startswith('Bearer '):
        token = auth_header[7:]
        token_source = 'manual'
        # Show first few chars to verify it's the user's token, not OBO
        token_preview = token[:10] if len(token) > 10 else token
        log('info', f"Using MANUAL token from Authorization header (starts with: {token_preview}..., length: {len(token)})")
    else:
        # Fall back to other methods
        log('debug', "No Authorization header, falling back to other auth methods")
        token, token_source = get_databricks_token_with_source()
        if token:
            token_preview = token[:10] if len(token) > 10 else token
            log('info', f"Using {token_source.upper()} token (starts with: {token_preview}..., length: {len(token)})")
    
    if not token:
        log('error', f"No token available. Headers: {dict(request.headers)}")
        return jsonify({
            'error': 'No authentication token available',
            'message': 'Please authenticate first',
            'oauth_required': True,
        }), 401
    
    host, host_source = get_databricks_host_with_source()
    if not host:
        log('error', f"No host available. Headers: {dict(request.headers)}")
        return jsonify({'error': 'No Databricks host configured', 'debug': 'No host found in headers or env'}), 400
    
    # Build target URL
    target_url = f"{host}/{path}"
    
    # Forward query parameters
    if request.query_string:
        target_url += f"?{request.query_string.decode('utf-8')}"
    
    # Prepare headers
    headers = {
        'Authorization': f'Bearer {token}',
        'Content-Type': 'application/json',
    }
    
    log('info', f"Proxying {request.method} to {target_url} (host from {host_source}, token from {token_source})")
    
    try:
        resp = http_requests.request(
            method=request.method,
            url=target_url,
            headers=headers,
            json=request.get_json(silent=True) if request.is_json else None,
            timeout=30,
        )
        
        # Log response details for debugging
        resp_preview = resp.text[:200] if len(resp.text) > 200 else resp.text
        log('info', f"Databricks response: {resp.status_code} - {resp_preview}")
        
        # Check for scope errors and enhance the message
        if resp.status_code in (401, 403):
            try:
                error_data = resp.json()
                error_message = error_data.get('message', '') or error_data.get('error', '')
                
                # If it's a scope error, add helpful information
                if 'scope' in error_message.lower():
                    # Determine which scopes might be needed based on the API path
                    required_scopes = _get_required_scopes_for_path(path)
                    enhanced_error = {
                        'error': error_message,
                        'error_code': error_data.get('error_code'),
                        'required_scopes': required_scopes,
                        'configured_scopes': OAUTH_SCOPES,
                        'help': 'The OAuth token does not have the required scopes. '
                               f'This API requires one of: {", ".join(required_scopes)}. '
                               'Please update the app\'s user_api_scopes in databricks.yml and redeploy.',
                    }
                    return jsonify(enhanced_error), resp.status_code
            except Exception:
                pass  # Fall through to return original response
        
        # For successful responses, add token source header for debugging
        response = Response(
            resp.content,
            status=resp.status_code,
            content_type=resp.headers.get('Content-Type', 'application/json'),
        )
        response.headers['X-Token-Source'] = token_source
        return response
    except http_requests.exceptions.RequestException as e:
        log('error', f"Proxy error: {e}")
        return jsonify({'error': f'Failed to connect to Databricks: {str(e)}'}), 502


def _get_required_scopes_for_path(path: str) -> list[str]:
    """
    Determine which OAuth scopes are likely required for a given API path.
    """
    path_lower = path.lower()
    
    # Map API paths to required scopes
    scope_mappings = [
        # SQL and warehouses
        (('/sql/', '/warehouses'), ['sql']),
        # Serving endpoints
        (('/serving-endpoints', '/endpoints'), ['serving.serving-endpoints']),
        # Vector search
        (('/vector-search', '/indexes'), ['vectorsearch.vector-search-indexes', 'vectorsearch.vector-search-endpoints']),
        # Genie
        (('/genie', '/dashboards'), ['dashboards.genie']),
        # Files and volumes
        (('/files', '/volumes', '/dbfs'), ['files.files']),
        # Unity Catalog
        (('/catalog', '/schemas', '/tables', '/functions'), ['sql']),
        # SCIM / Users
        (('/scim', '/users', '/me'), ['iam.current-user:read']),
        # Clusters
        (('/clusters',), ['clusters.clusters']),
        # Jobs
        (('/jobs',), ['jobs.jobs']),
        # MLflow
        (('/mlflow', '/experiments', '/models', '/registered-models'), ['mlflow.experiments', 'mlflow.registered-models']),
        # Workspace
        (('/workspace',), ['workspace.workspace']),
    ]
    
    for patterns, scopes in scope_mappings:
        if any(pattern in path_lower for pattern in patterns):
            return scopes
    
    # Default - return common scopes
    return ['sql', 'serving.serving-endpoints', 'files.files']


# =============================================================================
# Health & Debug
# =============================================================================

@app.route('/api/health')
def health_check():
    """Health check endpoint for Databricks Apps."""
    return jsonify({'status': 'healthy'})


# =============================================================================
# Unity Catalog & Resource APIs (using user auth when available)
# These APIs prefer the requesting user's credentials so that resource listings
# (catalogs, schemas, endpoints, etc.) reflect the user's own permissions.
# Falls back to the app's service principal / default SDK auth when no user
# token is available (e.g. local development without OBO headers).
# =============================================================================

def get_workspace_client():
    """
    Get a WorkspaceClient authenticated as the current user when possible.

    Token resolution order (same as get_databricks_token_with_source):
    1. Session token (OAuth flow)
    2. Authorization header Bearer token (user's PAT)
    3. X-Forwarded-Access-Token header (Databricks App on-behalf-of-user)
    4. Databricks SDK Config (env vars, profiles, etc.)
    5. DATABRICKS_TOKEN environment variable

    Falls back to default SDK auth (service principal) when no user token
    or host is available.
    """
    from databricks.sdk import WorkspaceClient

    try:
        token, source = get_databricks_token_with_source()
        host, _ = get_databricks_host_with_source()

        if token and host:
            host = host.rstrip('/')
            if not host.startswith('http'):
                host = f'https://{host}'
            log('debug', f"WorkspaceClient using {source} token for user auth")
            return WorkspaceClient(host=host, token=token)
    except Exception as e:
        log('warning', f"Failed to resolve user credentials, falling back to default SDK auth: {e}")

    log('debug', "WorkspaceClient using default SDK auth (service principal)")
    return WorkspaceClient()


def get_current_user_email() -> str | None:
    """
    Get the current user's email from OBO headers or by calling the API.
    """
    # First try OBO headers
    forwarded_email = request.headers.get('X-Forwarded-Email')
    if forwarded_email:
        return forwarded_email
    
    forwarded_username = request.headers.get('X-Forwarded-Preferred-Username')
    if forwarded_username:
        return forwarded_username
    
    # Try to get from WorkspaceClient
    try:
        w = get_workspace_client()
        me = w.current_user.me()
        return me.user_name
    except Exception as e:
        log('warning', f"Could not get current user: {e}")
        return None


def resolve_secret_value(secret_ref: dict, obo_token: str | None = None) -> str | None:
    """
    Resolve a Databricks secret reference to its actual value.
    
    Secret references look like: {"scope": "my_scope", "secret": "my_secret"}
    
    Args:
        secret_ref: Dictionary with 'scope' and 'secret' keys
        obo_token: Optional OBO token to use for authentication (uses user's permissions)
    
    Returns:
        The resolved secret value, or None if resolution fails
    """
    if not isinstance(secret_ref, dict):
        return None
    
    scope = secret_ref.get('scope')
    secret_key = secret_ref.get('secret')
    
    if not scope or not secret_key:
        return None
    
    try:
        host = get_databricks_host()
        if not host:
            log('warning', "Cannot resolve secret: no Databricks host configured")
            return None
        
        # Use OBO token if provided, otherwise fall back to default token
        token = obo_token
        if not token:
            token = get_databricks_token()
        
        if not token:
            log('warning', "Cannot resolve secret: no authentication token available")
            return None
        
        # Call Secrets API
        import requests
        api_url = f"{host}/api/2.0/secrets/get"
        headers = {
            'Authorization': f'Bearer {token}',
            'Content-Type': 'application/json',
        }
        payload = {
            'scope': scope,
            'key': secret_key,
        }
        
        log('info', f"Resolving secret {scope}/{secret_key}")
        response = requests.get(api_url, headers=headers, params=payload, timeout=30)
        
        if response.status_code == 200:
            data = response.json()
            # The secrets API returns the value base64 encoded
            import base64
            value_b64 = data.get('value')
            if value_b64:
                return base64.b64decode(value_b64).decode('utf-8')
        else:
            log('warning', f"Failed to resolve secret {scope}/{secret_key}: {response.status_code}")
        
        return None
    except Exception as e:
        log('error', f"Error resolving secret {scope}/{secret_key}: {e}")
        return None


def resolve_variable_value(value: any, obo_token: str | None = None) -> str | None:
    """
    Resolve a variable value which could be:
    - A plain string value
    - An environment variable reference: {"env": "VAR_NAME"}
    - A secret reference: {"scope": "scope_name", "secret": "secret_name"}
    
    Args:
        value: The value to resolve
        obo_token: Optional OBO token for secret resolution
    
    Returns:
        The resolved string value, or None if resolution fails
    """
    if value is None:
        return None
    
    # Plain string value
    if isinstance(value, str):
        return value
    
    # Dictionary-based reference
    if isinstance(value, dict):
        # Environment variable reference
        if 'env' in value:
            env_name = value.get('env')
            return os.environ.get(env_name)
        
        # Secret reference
        if 'scope' in value and 'secret' in value:
            return resolve_secret_value(value, obo_token)
        
        # Composite variable with options
        if 'options' in value:
            options = value.get('options', [])
            for opt in options:
                resolved = resolve_variable_value(opt, obo_token)
                if resolved:
                    return resolved
            return None
    
    return str(value) if value else None


def get_service_principal_credentials(sp_config: dict, obo_token: str | None = None) -> tuple[str | None, str | None]:
    """
    Get resolved credentials from a service principal configuration.
    
    Handles both direct values and references (env vars, secrets).
    
    Args:
        sp_config: Service principal config dict with 'client_id' and 'client_secret'
        obo_token: Optional OBO token for resolving secrets with user permissions
    
    Returns:
        tuple: (client_id, client_secret) with resolved values
    """
    if not sp_config or not isinstance(sp_config, dict):
        return None, None
    
    client_id = resolve_variable_value(sp_config.get('client_id'), obo_token)
    client_secret = resolve_variable_value(sp_config.get('client_secret'), obo_token)
    
    return client_id, client_secret


def sort_by_owner(items: list, current_user: str | None) -> list:
    """
    Sort items so that ones owned by the current user appear first.
    Within each group, sort alphabetically by name.
    """
    if not current_user:
        # Just sort alphabetically if we don't know the user
        return sorted(items, key=lambda x: x.get('name', '').lower())
    
    current_user_lower = current_user.lower()
    
    def sort_key(item):
        owner = (item.get('owner') or '').lower()
        name = (item.get('name') or '').lower()
        # Items owned by current user get priority (0), others get (1)
        is_owned = 0 if owner == current_user_lower else 1
        return (is_owned, name)
    
    return sorted(items, key=sort_key)


@app.route('/api/uc/catalogs')
def list_catalogs():
    """List all catalogs using WorkspaceClient, sorted by ownership."""
    try:
        w = get_workspace_client()
        current_user = get_current_user_email()
        log('debug', f"Listing catalogs for user: {current_user}")
        
        catalogs = list(w.catalogs.list())
        result = [
            {
                'name': c.name,
                'comment': c.comment,
                'owner': c.owner,
            }
            for c in catalogs
        ]
        
        # Sort by owner (current user's catalogs first)
        result = sort_by_owner(result, current_user)
        
        log('info', f"Listed {len(result)} catalogs (user: {current_user})")
        return jsonify({'catalogs': result, 'current_user': current_user})
    except Exception as e:
        log('error', f"Error listing catalogs: {e}")
        return jsonify({'error': str(e)}), 500


@app.route('/api/uc/schemas')
def list_schemas():
    """List schemas in a catalog using WorkspaceClient, sorted by ownership."""
    catalog = request.args.get('catalog')
    if not catalog:
        return jsonify({'error': 'catalog parameter required'}), 400
    
    try:
        w = get_workspace_client()
        current_user = get_current_user_email()
        log('debug', f"Listing schemas in {catalog} for user: {current_user}")
        
        schemas = list(w.schemas.list(catalog_name=catalog))
        result = [
            {
                'name': s.name,
                'full_name': s.full_name,
                'comment': s.comment,
                'owner': s.owner,
            }
            for s in schemas
        ]
        
        # Sort by owner (current user's schemas first)
        result = sort_by_owner(result, current_user)
        
        log('info', f"Listed {len(result)} schemas in catalog {catalog} (user: {current_user})")
        return jsonify({'schemas': result, 'current_user': current_user})
    except Exception as e:
        log('error', f"Error listing schemas in {catalog}: {e}")
        return jsonify({'error': str(e)}), 500


@app.route('/api/uc/tables')
def list_tables():
    """List tables in a schema using WorkspaceClient, sorted by ownership."""
    catalog = request.args.get('catalog')
    schema = request.args.get('schema')
    if not catalog or not schema:
        return jsonify({'error': 'catalog and schema parameters required'}), 400
    
    try:
        w = get_workspace_client()
        current_user = get_current_user_email()
        
        tables = list(w.tables.list(catalog_name=catalog, schema_name=schema))
        result = [
            {
                'name': t.name,
                'full_name': t.full_name,
                'table_type': t.table_type.value if t.table_type else None,
                'comment': t.comment,
                'owner': t.owner,
            }
            for t in tables
        ]
        
        # Sort by owner (current user's tables first)
        result = sort_by_owner(result, current_user)
        
        log('info', f"Listed {len(result)} tables in {catalog}.{schema}")
        return jsonify({'tables': result})
    except Exception as e:
        log('error', f"Error listing tables in {catalog}.{schema}: {e}")
        return jsonify({'error': str(e)}), 500


@app.route('/api/uc/table-columns')
def get_table_columns():
    """Get columns for a specific table using WorkspaceClient."""
    catalog = request.args.get('catalog')
    schema = request.args.get('schema')
    table = request.args.get('table')
    
    if not catalog or not schema or not table:
        return jsonify({'error': 'catalog, schema, and table parameters required'}), 400
    
    try:
        w = get_workspace_client()
        full_name = f"{catalog}.{schema}.{table}"
        
        # Get table info with columns
        table_info = w.tables.get(full_name=full_name)
        
        columns = []
        if table_info.columns:
            for col in table_info.columns:
                columns.append({
                    'name': col.name,
                    'type_name': col.type_name.value if col.type_name else None,
                    'type_text': col.type_text,
                    'comment': col.comment,
                    'nullable': col.nullable if col.nullable is not None else True,
                })
        
        log('info', f"Retrieved {len(columns)} columns from {full_name}")
        return jsonify({'columns': columns})
    except Exception as e:
        log('error', f"Error getting columns for {catalog}.{schema}.{table}: {e}")
        return jsonify({'error': str(e)}), 500


@app.route('/api/uc/functions')
def list_functions():
    """List functions in a schema using WorkspaceClient, sorted by ownership."""
    catalog = request.args.get('catalog')
    schema = request.args.get('schema')
    if not catalog or not schema:
        return jsonify({'error': 'catalog and schema parameters required'}), 400
    
    try:
        w = get_workspace_client()
        current_user = get_current_user_email()
        
        functions = list(w.functions.list(catalog_name=catalog, schema_name=schema))
        result = [
            {
                'name': f.name,
                'full_name': f.full_name,
                'comment': f.comment,
                'owner': f.owner,
                'input_params': [
                    {'name': p.name, 'type_text': p.type_text}
                    for p in (f.input_params.parameters if f.input_params else [])
                ] if f.input_params else [],
                'return_params': {
                    'type_text': f.return_params.parameters[0].type_text if f.return_params and f.return_params.parameters else None
                } if f.return_params else None,
            }
            for f in functions
        ]
        
        # Sort by owner (current user's functions first)
        result = sort_by_owner(result, current_user)
        
        log('info', f"Listed {len(result)} functions in {catalog}.{schema}")
        return jsonify({'functions': result})
    except Exception as e:
        log('error', f"Error listing functions in {catalog}.{schema}: {e}")
        return jsonify({'error': str(e)}), 500


@app.route('/api/uc/volumes')
def list_volumes():
    """List volumes in a schema using WorkspaceClient, sorted by ownership."""
    catalog = request.args.get('catalog')
    schema = request.args.get('schema')
    if not catalog or not schema:
        return jsonify({'error': 'catalog and schema parameters required'}), 400
    
    try:
        w = get_workspace_client()
        current_user = get_current_user_email()
        
        volumes = list(w.volumes.list(catalog_name=catalog, schema_name=schema))
        result = [
            {
                'name': v.name,
                'full_name': v.full_name,
                'volume_type': v.volume_type.value if v.volume_type else None,
                'comment': v.comment,
                'owner': v.owner,
            }
            for v in volumes
        ]
        
        # Sort by owner (current user's volumes first)
        result = sort_by_owner(result, current_user)
        
        log('info', f"Listed {len(result)} volumes in {catalog}.{schema}")
        return jsonify({'volumes': result})
    except Exception as e:
        log('error', f"Error listing volumes in {catalog}.{schema}: {e}")
        return jsonify({'error': str(e)}), 500


@app.route('/api/uc/registered-models')
def list_registered_models():
    """List registered models using WorkspaceClient, sorted by ownership."""
    try:
        w = get_workspace_client()
        current_user = get_current_user_email()
        
        # List all registered models (Unity Catalog models)
        models = list(w.registered_models.list())
        result = [
            {
                'name': m.name,
                'full_name': m.full_name,
                'comment': m.comment,
                'owner': m.owner,
            }
            for m in models
        ]
        
        # Sort by owner (current user's models first)
        result = sort_by_owner(result, current_user)
        
        log('info', f"Listed {len(result)} registered models")
        return jsonify({'models': result})
    except Exception as e:
        log('error', f"Error listing registered models: {e}")
        return jsonify({'error': str(e)}), 500


@app.route('/api/uc/model-config', methods=['GET'])
def load_model_config():
    """Load the model_config YAML from a UC-registered dao-ai agent.

    Resolves the Champion alias and downloads the model_config artifact,
    returning the raw YAML string for import into the builder UI.

    Query params:
    - model_name: Full UC model name (catalog.schema.model_name) (required)
    """
    model_name = request.args.get('model_name')
    if not model_name:
        return jsonify({'error': 'model_name parameter required'}), 400

    try:
        import mlflow
        import tempfile
        import os as os_module

        host, _ = get_databricks_host_with_source()
        token, _ = get_databricks_token_with_source()

        if not host:
            return jsonify({'error': 'No Databricks workspace URL configured'}), 400
        if not token:
            return jsonify({'error': 'No authentication token available'}), 401

        orig_env = {
            'DATABRICKS_HOST': os_module.environ.get('DATABRICKS_HOST'),
            'DATABRICKS_TOKEN': os_module.environ.get('DATABRICKS_TOKEN'),
            'MLFLOW_TRACKING_TOKEN': os_module.environ.get('MLFLOW_TRACKING_TOKEN'),
        }

        try:
            os_module.environ['DATABRICKS_HOST'] = normalize_host(host)
            os_module.environ['DATABRICKS_TOKEN'] = token
            os_module.environ['MLFLOW_TRACKING_TOKEN'] = token

            mlflow.set_tracking_uri("databricks")
            mlflow.set_registry_uri("databricks-uc")

            # Resolve Champion alias to a version
            client = mlflow.MlflowClient()
            mv = client.get_model_version_by_alias(model_name, "Champion")
            version = mv.version

            # Download model artifact and read model_config.yaml
            model_uri = f"models:/{model_name}/{version}"
            local_path = mlflow.artifacts.download_artifacts(model_uri)

            config_path = os_module.path.join(local_path, "model_config.yaml")
            if not os_module.path.exists(config_path):
                # Try .yml extension as fallback
                config_path = os_module.path.join(local_path, "model_config.yml")
            if not os_module.path.exists(config_path):
                return jsonify({'error': 'model_config.yaml not found in model artifact'}), 404

            with open(config_path, 'r') as f:
                yaml_content = f.read()

            log('info', f"Loaded model config for {model_name} version {version}")
            return jsonify({'yaml': yaml_content, 'model_name': model_name, 'version': version})

        finally:
            for var, val in orig_env.items():
                if val is not None:
                    os_module.environ[var] = val
                elif var in os_module.environ:
                    del os_module.environ[var]

    except Exception as e:
        log('error', f"Error loading model config for {model_name}: {e}")
        return jsonify({'error': str(e)}), 500


@app.route('/api/uc/register-model', methods=['POST'])
def register_model():
    """Register a dao-ai agent config to Unity Catalog without deploying an endpoint.

    Calls dao_ai's create_agent() to log the model to MLflow and register it
    in UC as a versioned artifact. No Model Serving endpoint or App is created.

    JSON body:
    - config: The agent configuration as a dictionary (required)
    - credentials: Optional credential configuration (same schema as /api/deploy/quick)
        - type: 'app' | 'obo' | 'manual_sp' | 'manual_pat'
        - pat: Required for manual_pat
        - client_id: Required for manual_sp
        - client_secret: Required for manual_sp

    Returns the registered model name and version number.
    """
    import yaml
    import tempfile
    import os as os_module

    data = request.get_json() or {}
    config = data.get('config')
    credentials = data.get('credentials', {})

    if not config:
        return jsonify({'error': 'config is required'}), 400

    host, _ = get_databricks_host_with_source()
    cred_type = credentials.get('type', 'obo')
    token = None
    client_id = None
    client_secret = None

    if cred_type == 'manual_pat':
        token = credentials.get('pat')
        if not token:
            return jsonify({'error': 'pat is required for manual_pat credential type'}), 400
    elif cred_type == 'manual_sp':
        client_id = credentials.get('client_id')
        client_secret = credentials.get('client_secret')
        if not client_id or not client_secret:
            return jsonify({'error': 'client_id and client_secret are required for manual_sp credential type'}), 400
    elif cred_type == 'app':
        client_id = os.environ.get('DATABRICKS_CLIENT_ID')
        client_secret = os.environ.get('DATABRICKS_CLIENT_SECRET')
        if not client_id or not client_secret:
            return jsonify({'error': 'Application service principal not configured'}), 400
    else:  # obo or default
        token, token_source = get_databricks_token_with_source()
        if not token:
            client_id = os.environ.get('DATABRICKS_CLIENT_ID')
            client_secret = os.environ.get('DATABRICKS_CLIENT_SECRET')
            if not client_id or not client_secret:
                return jsonify({'error': 'No credentials available for registration'}), 401

    if not host:
        return jsonify({'error': 'No Databricks workspace URL configured'}), 400

    orig_env = {
        'DATABRICKS_HOST': os_module.environ.get('DATABRICKS_HOST'),
        'DATABRICKS_TOKEN': os_module.environ.get('DATABRICKS_TOKEN'),
        'DATABRICKS_CLIENT_ID': os_module.environ.get('DATABRICKS_CLIENT_ID'),
        'DATABRICKS_CLIENT_SECRET': os_module.environ.get('DATABRICKS_CLIENT_SECRET'),
        'MLFLOW_TRACKING_TOKEN': os_module.environ.get('MLFLOW_TRACKING_TOKEN'),
    }

    config_path = None
    try:
        from dao_ai.config import AppConfig
        import mlflow

        # Write config dict to temp YAML file
        with tempfile.NamedTemporaryFile(mode='w', suffix='.yaml', delete=False) as f:
            yaml.dump(config, f)
            config_path = f.name

        # Clear conflicting auth then set resolved credentials
        for var in ['DATABRICKS_TOKEN', 'DATABRICKS_CLIENT_ID', 'DATABRICKS_CLIENT_SECRET', 'MLFLOW_TRACKING_TOKEN']:
            if var in os_module.environ:
                del os_module.environ[var]

        os_module.environ['DATABRICKS_HOST'] = normalize_host(host)
        if token:
            os_module.environ['DATABRICKS_TOKEN'] = token
            os_module.environ['MLFLOW_TRACKING_TOKEN'] = token
        elif client_id and client_secret:
            os_module.environ['DATABRICKS_CLIENT_ID'] = client_id
            os_module.environ['DATABRICKS_CLIENT_SECRET'] = client_secret

        mlflow.set_tracking_uri("databricks")
        mlflow.set_registry_uri("databricks-uc")

        app_config = AppConfig.from_file(config_path)
        app_config.create_agent()

        registered_model_name = app_config.app.registered_model.full_name
        client = mlflow.MlflowClient()
        mv = client.get_model_version_by_alias(registered_model_name, "Champion")

        log('info', f"Registered {registered_model_name} version {mv.version}")
        return jsonify({
            'model_name': registered_model_name,
            'version': mv.version,
            'alias': 'Champion',
        })

    except Exception as e:
        log('error', f"Error registering model: {e}")
        return jsonify({'error': str(e)}), 500

    finally:
        if config_path and os_module.path.exists(config_path):
            os_module.remove(config_path)
        for var, val in orig_env.items():
            if val is not None:
                os_module.environ[var] = val
            elif var in os_module.environ:
                del os_module.environ[var]


@app.route('/api/uc/prompts', methods=['GET', 'POST'])
def list_prompts():
    """List MLflow prompts in a catalog.schema using MLflow SDK.
    
    Query params (GET) or JSON body (POST):
    - catalog: The catalog name (required)
    - schema: The schema name (required)
    - service_principal: Optional service principal config for authentication
      If the SP uses secret references, they'll be resolved with user's OBO token
    
    Returns prompts with their name, description, aliases, and latest version info.
    """
    # Support both GET (query params) and POST (JSON body with service principal)
    if request.method == 'POST':
        data = request.get_json() or {}
        catalog = data.get('catalog')
        schema = data.get('schema')
        service_principal = data.get('service_principal')
    else:
        catalog = request.args.get('catalog')
        schema = request.args.get('schema')
        service_principal = None
    
    if not catalog or not schema:
        return jsonify({'error': 'catalog and schema parameters required'}), 400
    
    try:
        current_user = get_current_user_email()
        log('info', f"Listing prompts in {catalog}.{schema} for user: {current_user}")
        
        # Log all forwarded headers for debugging
        log('info', f"=== PROMPTS ENDPOINT DEBUG ===")
        log('info', f"X-Forwarded-Host: {request.headers.get('X-Forwarded-Host', 'NOT SET')}")
        log('info', f"X-Forwarded-Access-Token: {'SET (len={})'.format(len(request.headers.get('X-Forwarded-Access-Token', ''))) if request.headers.get('X-Forwarded-Access-Token') else 'NOT SET'}")
        log('info', f"X-Forwarded-Email: {request.headers.get('X-Forwarded-Email', 'NOT SET')}")
        log('info', f"Host header: {request.headers.get('Host', 'NOT SET')}")
        log('info', f"DATABRICKS_HOST env: {os.environ.get('DATABRICKS_HOST', 'NOT SET')}")
        
        result = []
        
        # Get host from DATABRICKS_HOST environment variable (set by Databricks Apps)
        host, host_source = get_databricks_host_with_source()
        
        if not host:
            log('warning', "No Databricks host available. "
                         f"DATABRICKS_HOST env: {os.environ.get('DATABRICKS_HOST', 'NOT SET')}")
            return jsonify({
                'error': 'No Databricks host configured',
                'help': 'Set DATABRICKS_HOST environment variable or use OAuth login.'
            }), 401
        
        # Normalize host (remove trailing slash)
        host = host.rstrip('/')
        log('info', f"Using host={host} from source={host_source}")
        
        # Determine which credentials to use
        sp_client_id = None
        sp_client_secret = None
        use_sp_auth = False
        
        if service_principal:
            log('info', f"Using service principal for prompt registry access")
            # Get OBO token for resolving any secrets in the service principal config
            obo_token, _ = get_databricks_token_with_source()
            
            # Resolve service principal credentials (may involve secret lookups)
            sp_client_id, sp_client_secret = get_service_principal_credentials(
                service_principal, obo_token if obo_token else None
            )
            
            if sp_client_id and sp_client_secret:
                use_sp_auth = True
                log('info', f"Resolved service principal credentials: client_id={sp_client_id[:8]}...")
            else:
                log('warning', f"Failed to resolve service principal credentials")
        
        # Save original environment variables to restore later
        orig_env = {}
        env_vars_to_manage = ['DATABRICKS_HOST', 'DATABRICKS_TOKEN', 'DATABRICKS_CLIENT_ID', 'DATABRICKS_CLIENT_SECRET']
        for var in env_vars_to_manage:
            orig_env[var] = os.environ.get(var)
        
        try:
            # Clear all auth-related env vars first to prevent conflicts
            for var in env_vars_to_manage:
                if var in os.environ:
                    del os.environ[var]
            
            # Set DATABRICKS_HOST (ensure https:// scheme)
            os.environ['DATABRICKS_HOST'] = normalize_host(host)
            log('info', f"Set DATABRICKS_HOST={normalize_host(host)}")
            
            if use_sp_auth:
                # Use service principal authentication
                os.environ['DATABRICKS_CLIENT_ID'] = sp_client_id
                os.environ['DATABRICKS_CLIENT_SECRET'] = sp_client_secret
                log('info', f"Set DATABRICKS_CLIENT_ID and DATABRICKS_CLIENT_SECRET for SP auth")
            else:
                # Fall back to user's token
                token, token_source = get_databricks_token_with_source()
                if token:
                    os.environ['DATABRICKS_TOKEN'] = token
                    log('info', f"Set DATABRICKS_TOKEN from {token_source}")
                else:
                    log('warning', "No authentication token available")
                    return jsonify({'error': 'No authentication token available'}), 401
            
            # Use MLflow SDK to search prompts
            import mlflow
            
            # Log current environment for debugging
            log('info', f"DATABRICKS_HOST env: {os.environ.get('DATABRICKS_HOST', 'NOT SET')}")
            log('info', f"DATABRICKS_TOKEN env: {'SET (len={})'.format(len(os.environ.get('DATABRICKS_TOKEN', ''))) if os.environ.get('DATABRICKS_TOKEN') else 'NOT SET'}")
            log('info', f"DATABRICKS_CLIENT_ID env: {os.environ.get('DATABRICKS_CLIENT_ID', 'NOT SET')[:8] + '...' if os.environ.get('DATABRICKS_CLIENT_ID') else 'NOT SET'}")
            
            mlflow.set_tracking_uri("databricks")
            
            log('info', f"Searching prompts with MLflow SDK: catalog={catalog}, schema={schema}")
            
            try:
                prompts_list = mlflow.genai.search_prompts(
                    filter_string=f"catalog = '{catalog}' AND schema = '{schema}'",
                    max_results=100
                )
                log('info', f"MLflow SDK returned {len(prompts_list)} prompts")
                
                # PromptInfo has typed attributes: name, description, tags
                for p in prompts_list:
                    prompt_full_name: str = p.name
                    short_name: str = prompt_full_name.split('.')[-1] if '.' in prompt_full_name else prompt_full_name
                    
                    # Extract tags - search_prompts returns tags including PromptVersionCount
                    # PromptInfo.tags is Dict[str, str]
                    tags: dict[str, str] = p.tags if p.tags else {}
                    
                    # Get PromptVersionCount from tags to determine latest version
                    # This avoids having to call load_prompt which can fail
                    version_count_str: str = tags.get('PromptVersionCount', '1')
                    try:
                        version_count: int = int(version_count_str)
                    except (ValueError, TypeError):
                        version_count = 1
                    
                    # Build version list (all versions from 1 to version_count)
                    versions_list: list[dict[str, str | list[str]]] = []
                    for v in range(version_count, 0, -1):  # Descending order
                        versions_list.append({
                            'version': str(v),
                            'aliases': [],
                        })
                    
                    # PromptInfo.description is Optional[str]
                    description: str = p.description if p.description else ''
                    
                    prompt_info: dict[str, str | dict | list | None] = {
                        'name': short_name,
                        'full_name': prompt_full_name,
                        'description': description,
                        'tags': tags,
                        'aliases': [],  # Aliases will be fetched when user selects the prompt
                        'latest_version': str(version_count) if version_count > 0 else '1',
                        'versions': versions_list,
                    }
                    
                    log('debug', f"Prompt {short_name}: version_count={version_count}, tags={tags}")
                    
                    result.append(prompt_info)
                
            except Exception as mlflow_err:
                import traceback
                log('warning', f"MLflow SDK error: {mlflow_err}")
                log('warning', f"MLflow SDK traceback: {traceback.format_exc()}")
                # Fall back to REST API
                log('info', "Falling back to REST API for prompts")
                
                import requests
                
                # Get a token for REST API
                if use_sp_auth:
                    # Get OAuth token for the service principal
                    oauth_url = f"{host}/oidc/v1/token"
                    oauth_data = {
                        'grant_type': 'client_credentials',
                        'client_id': sp_client_id,
                        'client_secret': sp_client_secret,
                        'scope': 'all-apis',
                    }
                    oauth_response = requests.post(oauth_url, data=oauth_data, timeout=30)
                    if oauth_response.status_code == 200:
                        oauth_result = oauth_response.json()
                        token = oauth_result.get('access_token')
                        log('info', "Got OAuth token for REST API fallback")
                    else:
                        log('error', f"OAuth failed: {oauth_response.status_code} - {oauth_response.text}")
                        return jsonify({'error': f'OAuth failed: {oauth_response.text}'}), 401
                else:
                    token, _ = get_databricks_token_with_source()
                
                if not token:
                    return jsonify({'error': 'No authentication token available'}), 401
                
                headers = {
                    'Authorization': f'Bearer {token}',
                    'Content-Type': 'application/json',
                }
                
                api_url = f"{host}/api/2.0/mlflow/unity-catalog/prompts/search"
                payload = {
                    'filter': f"catalog = '{catalog}' AND schema = '{schema}'",
                    'max_results': 100,
                }
                
                response = requests.post(api_url, headers=headers, json=payload, timeout=30)
                log('info', f"REST API response status: {response.status_code}")
                log('debug', f"REST API response headers: {dict(response.headers)}")
                log('debug', f"REST API response text (first 500 chars): {response.text[:500] if response.text else 'EMPTY'}")
                
                if response.status_code == 200:
                    if not response.text or not response.text.strip():
                        log('error', "REST API returned empty response")
                        return jsonify({'error': 'REST API returned empty response'}), 500
                    try:
                        data = response.json()
                    except Exception as json_err:
                        log('error', f"Failed to parse REST API response as JSON: {json_err}")
                        log('error', f"Raw response: {response.text[:1000]}")
                        return jsonify({'error': f'Failed to parse response: {json_err}'}), 500
                    prompts_data = data.get('prompts', [])
                    log('info', f"REST API returned {len(prompts_data)} prompts")
                    
                    for p in prompts_data:
                        prompt_full_name = p.get('name', '')
                        short_name = prompt_full_name.split('.')[-1] if '.' in prompt_full_name else prompt_full_name
                        
                        prompt_info = {
                            'name': short_name,
                            'full_name': prompt_full_name,
                            'description': p.get('description', ''),
                            'tags': p.get('tags', {}),
                            'aliases': [],
                            'latest_version': None,
                            'versions': [],
                        }
                        
                        # Get versions for this prompt
                        try:
                            # Correct endpoint format: /api/2.0/mlflow/unity-catalog/prompts/{prompt-name}/versions/search
                            from urllib.parse import quote
                            # Keep dots unencoded as they're part of the catalog.schema.name format
                            encoded_name = quote(prompt_full_name, safe='.')
                            versions_url = f"{host}/api/2.0/mlflow/unity-catalog/prompts/{encoded_name}/versions/search"
                            versions_response = requests.get(versions_url, headers=headers, timeout=30)
                            
                            if versions_response.status_code == 200:
                                versions_data = versions_response.json()
                                # Handle both wrapped and unwrapped response formats
                                versions_list = versions_data.get('prompt_versions', []) if isinstance(versions_data, dict) else versions_data
                                
                                all_aliases = set()
                                version_infos = []
                                latest_version = 0
                                
                                for v in versions_list:
                                    version_val = v.get('version')
                                    version_num = int(version_val) if version_val is not None else 0
                                    v_aliases = v.get('aliases', [])
                                    all_aliases.update(v_aliases)
                                    
                                    version_infos.append({
                                        'version': str(version_num),
                                        'aliases': v_aliases,
                                    })
                                    
                                    if version_num > latest_version:
                                        latest_version = version_num
                                
                                prompt_info['aliases'] = sorted(list(all_aliases))
                                prompt_info['latest_version'] = str(latest_version) if latest_version > 0 else None
                                prompt_info['versions'] = sorted(version_infos, key=lambda x: int(x['version']) if x['version'] else 0, reverse=True)
                        except Exception as ve:
                            log('debug', f"Could not get versions for {prompt_full_name}: {ve}")
                        
                        result.append(prompt_info)
                    
                    log('info', f"Found {len(result)} prompts via REST API")
                    
                elif response.status_code == 403:
                    log('error', f"Permission denied (403): {response.text}")
                    return jsonify({'error': f'Permission denied to access prompts. Response: {response.text}'}), 403
                else:
                    log('error', f"REST API failed with status {response.status_code}: {response.text}")
                    return jsonify({'error': f'Failed to search prompts: {response.status_code} - {response.text}'}), response.status_code
        
        finally:
            # Restore original environment variables
            for var in env_vars_to_manage:
                if orig_env[var] is not None:
                    os.environ[var] = orig_env[var]
                elif var in os.environ:
                    del os.environ[var]
            log('debug', "Restored original environment variables")
        
        # Sort by name alphabetically
        result = sorted(result, key=lambda x: x['name'].lower())
        
        log('info', f"Returning {len(result)} prompts in {catalog}.{schema}")
        return jsonify({'prompts': result})
        
    except Exception as e:
        import traceback
        log('error', f"Error listing prompts in {catalog}.{schema}: {e}")
        log('error', f"Traceback: {traceback.format_exc()}")
        return jsonify({'error': str(e)}), 500


@app.route('/api/uc/prompt-details', methods=['GET', 'POST'])
def get_prompt_details():
    """Get detailed information about a specific prompt including versions, aliases, and template.
    
    Query params (GET) or JSON body (POST):
    - name: The full prompt name (catalog.schema.name) (required)
    - service_principal: Optional service principal config for authentication
    
    Returns prompt details including all versions, aliases, tags, and template content.
    Uses MLflow SDK: get_prompt_tags() for tags, load_prompt() for template.
    """
    log('info', "========================================")
    log('info', "=== GET_PROMPT_DETAILS ENDPOINT HIT ===")
    log('info', "========================================")
    
    # Support both GET (query params) and POST (JSON body with service principal)
    if request.method == 'POST':
        data = request.get_json() or {}
        full_name = data.get('name')
        service_principal = data.get('service_principal')
    else:
        full_name = request.args.get('name')
        service_principal = None
    
    log('info', f"Prompt details request: name={full_name}, has_service_principal={service_principal is not None}")
    
    if not full_name:
        return jsonify({'error': 'name parameter required'}), 400
    
    try:
        # Get host from DATABRICKS_HOST environment variable
        host, host_source = get_databricks_host_with_source()
        
        if not host:
            log('warning', f"No Databricks host available. "
                         f"DATABRICKS_HOST env: {os.environ.get('DATABRICKS_HOST', 'NOT SET')}")
            return jsonify({
                'error': 'No Databricks host configured',
                'help': 'Set DATABRICKS_HOST environment variable.'
            }), 401
        
        # Normalize host
        host = host.rstrip('/')
        log('info', f"Using host={host} from source={host_source}")
        
        result = {
            'name': full_name.split('.')[-1] if '.' in full_name else full_name,
            'full_name': full_name,
            'versions': [],
            'aliases': [],
            'tags': {},
            'latest_version': None,
            'template': None,
            'description': '',
        }
        
        # Determine which credentials to use for SP auth
        sp_client_id = None
        sp_client_secret = None
        use_sp_auth = False
        
        if service_principal:
            log('info', f"Using service principal for prompt details access")
            obo_token, _ = get_databricks_token_with_source()
            sp_client_id, sp_client_secret = get_service_principal_credentials(
                service_principal, obo_token
            )
            if sp_client_id and sp_client_secret:
                use_sp_auth = True
                log('info', f"Resolved service principal credentials: client_id={sp_client_id[:8]}...")
        
        # Save original environment variables to restore later
        orig_env = {}
        env_vars_to_manage = ['DATABRICKS_HOST', 'DATABRICKS_TOKEN', 'DATABRICKS_CLIENT_ID', 'DATABRICKS_CLIENT_SECRET']
        for var in env_vars_to_manage:
            orig_env[var] = os.environ.get(var)
        
        try:
            # Clear all auth-related env vars first to prevent conflicts
            for var in env_vars_to_manage:
                if var in os.environ:
                    del os.environ[var]
            
            # Set DATABRICKS_HOST (ensure https:// scheme)
            os.environ['DATABRICKS_HOST'] = normalize_host(host)
            
            if use_sp_auth:
                os.environ['DATABRICKS_CLIENT_ID'] = sp_client_id
                os.environ['DATABRICKS_CLIENT_SECRET'] = sp_client_secret
                log('info', f"Set DATABRICKS_CLIENT_ID and DATABRICKS_CLIENT_SECRET for SP auth")
            else:
                token, token_source = get_databricks_token_with_source()
                if token:
                    os.environ['DATABRICKS_TOKEN'] = token
                    log('info', f"Set DATABRICKS_TOKEN from {token_source}")
                else:
                    log('warning', "No authentication token available")
                    return jsonify({'error': 'No authentication token available'}), 401
            
            log('info', f"Getting details for prompt: {full_name}")
            
            # Use REST API to get prompt metadata (including aliases and tags)
            import requests
            from urllib.parse import quote
            
            # Get token for REST API call
            rest_token: str | None = None
            if use_sp_auth:
                oauth_url = f"{host}/oidc/v1/token"
                oauth_data = {
                    'grant_type': 'client_credentials',
                    'client_id': sp_client_id,
                    'client_secret': sp_client_secret,
                    'scope': 'all-apis',
                }
                oauth_response = requests.post(oauth_url, data=oauth_data, timeout=30)
                if oauth_response.status_code == 200:
                    rest_token = oauth_response.json().get('access_token')
                else:
                    log('error', f"OAuth failed: {oauth_response.status_code}")
            else:
                rest_token, _ = get_databricks_token_with_source()
            
            if not rest_token:
                return jsonify({'error': 'No authentication token available'}), 401
            
            headers = {
                'Authorization': f'Bearer {rest_token}',
            }
            
            # Keep dots unencoded as they're part of the catalog.schema.name format
            encoded_name = quote(full_name, safe='.')
            
            # First, get prompt metadata (including aliases) from /prompts/{prompt-name}
            prompt_url = f"{host}/api/2.0/mlflow/unity-catalog/prompts/{encoded_name}"
            log('info', f"Calling REST API for prompt metadata: GET {prompt_url}")
            prompt_response = requests.get(prompt_url, headers=headers, timeout=30)
            
            if prompt_response.status_code == 200:
                prompt_data = prompt_response.json()
                
                # Extract description
                result['description'] = prompt_data.get('description', '')
                
                # Extract aliases - format: [{"alias": "champion", "version": "15"}, ...]
                aliases_data = prompt_data.get('aliases', [])
                alias_names: list[str] = []
                alias_version_map: dict[str, str] = {}
                for a in aliases_data:
                    alias_name = a.get('alias', '')
                    alias_version = a.get('version', '')
                    if alias_name:
                        alias_names.append(alias_name)
                        alias_version_map[alias_name] = alias_version
                result['aliases'] = sorted(alias_names)
                result['alias_versions'] = alias_version_map  # Map of alias -> version
                
                # Extract tags - format: [{"key": "...", "value": "..."}, ...]
                tags_data = prompt_data.get('tags', [])
                tags_dict: dict[str, str] = {}
                for t in tags_data:
                    key = t.get('key', '')
                    value = t.get('value', '')
                    if key:
                        tags_dict[key] = value
                result['tags'] = tags_dict
                
                # Get PromptVersionCount from tags
                version_count_str = tags_dict.get('PromptVersionCount', '1')
                try:
                    version_count = int(version_count_str)
                    result['latest_version'] = str(version_count)
                except (ValueError, TypeError):
                    result['latest_version'] = '1'
                
                log('info', f"Got prompt metadata: {len(alias_names)} aliases, {len(tags_dict)} tags, latest_version={result['latest_version']}")
            else:
                log('warning', f"Could not get prompt metadata: {prompt_response.status_code} - {prompt_response.text}")
            
            # Then, get all versions from /prompts/{prompt-name}/versions/search
            # NOTE: This endpoint requires POST, not GET!
            versions_url = f"{host}/api/2.0/mlflow/unity-catalog/prompts/{encoded_name}/versions/search"
            log('info', f"=== VERSIONS API CALL ===")
            log('info', f"Calling REST API for versions: POST {versions_url}")
            
            try:
                # Use POST with empty JSON body - this is required by the API
                versions_response = requests.post(
                    versions_url, 
                    headers={**headers, 'Content-Type': 'application/json'},
                    json={},  # Empty body for search
                    timeout=30
                )
                log('info', f"Versions API response status: {versions_response.status_code}")
            except Exception as versions_err:
                log('error', f"Versions API request failed with exception: {versions_err}")
                versions_response = None
            
            if versions_response and versions_response.status_code == 200:
                try:
                    versions_data = versions_response.json()
                    log('info', f"Versions API raw response keys: {list(versions_data.keys()) if isinstance(versions_data, dict) else 'not a dict'}")
                    log('info', f"Versions API raw response: {str(versions_data)[:500]}...")  # Log first 500 chars
                except Exception as json_err:
                    log('error', f"Failed to parse versions JSON: {json_err}")
                    versions_data = {}
                
                # Handle both wrapped and unwrapped response formats
                versions_list = versions_data.get('prompt_versions', []) if isinstance(versions_data, dict) else versions_data
                if not isinstance(versions_list, list):
                    log('warning', f"versions_list is not a list, it's: {type(versions_list)}")
                    versions_list = []
                
                log('info', f"Versions list contains {len(versions_list)} items")
                
                latest_version_num: int = 0
                
                for v in versions_list:
                    version_val = v.get('version')
                    version_num = int(str(version_val)) if version_val is not None else 0
                    log('debug', f"Processing version {version_num}")
                    
                    # Find aliases for this version
                    version_aliases: list[str] = []
                    for alias_name, alias_ver in result.get('alias_versions', {}).items():
                        if str(alias_ver) == str(version_num):
                            version_aliases.append(alias_name)
                    
                    version_info = {
                        'version': str(version_num),
                        'aliases': version_aliases,
                        'description': v.get('description', ''),
                        'template': v.get('template', ''),
                    }
                    result['versions'].append(version_info)
                    
                    if version_num > latest_version_num:
                        latest_version_num = version_num
                
                result['versions'].sort(key=lambda x: int(x['version']) if x['version'] else 0, reverse=True)
                
                # Update latest_version if not set
                if not result.get('latest_version') and latest_version_num > 0:
                    result['latest_version'] = str(latest_version_num)
                
                # Get template from the latest version
                if result['versions'] and not result.get('template'):
                    result['template'] = result['versions'][0].get('template', '')
                
                log('info', f"REST API returned {len(versions_list)} versions, processed {len(result['versions'])} versions")
                log('info', f"Final versions in result: {[v['version'] for v in result['versions']]}")
            elif versions_response:
                log('error', f"=== VERSIONS API FAILED ===")
                log('error', f"Could not get versions: status={versions_response.status_code}")
                try:
                    error_text = versions_response.text[:1000] if versions_response.text else 'empty'
                    log('error', f"Response text: {error_text}")
                except Exception:
                    log('error', "Could not read response text")
            else:
                log('error', f"=== VERSIONS API FAILED - No response ===")
            
            log('info', f"Retrieved details for prompt {full_name}: {len(result['versions'])} versions, {len(result['aliases'])} aliases, {len(result['tags'])} tags")
            return jsonify(result)
            
        finally:
            # Restore original environment variables
            for var in env_vars_to_manage:
                if orig_env[var] is not None:
                    os.environ[var] = orig_env[var]
                elif var in os.environ:
                    del os.environ[var]
            log('debug', "Restored original environment variables")
        
    except Exception as e:
        import traceback
        log('error', f"Error getting prompt details for {full_name}: {e}")
        log('error', f"Traceback: {traceback.format_exc()}")
        return jsonify({'error': str(e)}), 500


@app.route('/api/uc/prompt-template', methods=['GET', 'POST'])
def get_prompt_template():
    """Get the template content for a specific prompt version or alias.
    
    Query params (GET) or JSON body (POST):
    - name: The full prompt name (catalog.schema.name) (required)
    - version: The version number (optional, mutually exclusive with alias)
    - alias: The alias name (optional, e.g., 'latest', 'champion', 'default')
    - service_principal: Optional service principal config for authentication
    
    Returns the prompt template content.
    
    Uses REST API to fetch the prompt template.
    Supports aliases: latest, champion, default, or any custom alias.
    """
    # Support both GET (query params) and POST (JSON body with service principal)
    if request.method == 'POST':
        data = request.get_json() or {}
        full_name = data.get('name')
        version = data.get('version')
        alias = data.get('alias')
        service_principal = data.get('service_principal')
    else:
        full_name = request.args.get('name')
        version = request.args.get('version')
        alias = request.args.get('alias')
        service_principal = None
    
    if not full_name:
        return jsonify({'error': 'name parameter required'}), 400
    
    try:
        # Get host
        host, host_source = get_databricks_host_with_source()
        
        if not host:
            log('warning', f"No Databricks host available.")
            return jsonify({
                'error': 'No Databricks host configured',
            }), 401
        
        # Normalize host
        host = host.rstrip('/')
        
        # Determine which credentials to use for SP auth
        sp_client_id: str | None = None
        sp_client_secret: str | None = None
        use_sp_auth: bool = False
        
        if service_principal:
            log('info', f"Using service principal for prompt template access")
            obo_token, _ = get_databricks_token_with_source()
            sp_client_id, sp_client_secret = get_service_principal_credentials(
                service_principal, obo_token
            )
            if sp_client_id and sp_client_secret:
                use_sp_auth = True
                log('info', f"Resolved service principal credentials: client_id={sp_client_id[:8]}...")
        
        # Save original environment variables to restore later
        orig_env: dict[str, str | None] = {}
        env_vars_to_manage = ['DATABRICKS_HOST', 'DATABRICKS_TOKEN', 'DATABRICKS_CLIENT_ID', 'DATABRICKS_CLIENT_SECRET']
        for var in env_vars_to_manage:
            orig_env[var] = os.environ.get(var)
        
        try:
            # Clear all auth-related env vars first
            for var in env_vars_to_manage:
                if var in os.environ:
                    del os.environ[var]
            
            # Set DATABRICKS_HOST (ensure https:// scheme)
            os.environ['DATABRICKS_HOST'] = normalize_host(host)
            
            # Get token for authentication
            token: str | None = None
            if use_sp_auth:
                # Get OAuth token for the service principal
                import requests as req
                oauth_url = f"{host}/oidc/v1/token"
                oauth_data = {
                    'grant_type': 'client_credentials',
                    'client_id': sp_client_id,
                    'client_secret': sp_client_secret,
                    'scope': 'all-apis',
                }
                oauth_response = req.post(oauth_url, data=oauth_data, timeout=30)
                if oauth_response.status_code == 200:
                    token = oauth_response.json().get('access_token')
                    log('info', "Got OAuth token for service principal")
                else:
                    log('error', f"OAuth failed: {oauth_response.status_code} - {oauth_response.text}")
                    return jsonify({'error': f'OAuth failed: {oauth_response.text}'}), 401
            else:
                token, token_source = get_databricks_token_with_source()
                
            if not token:
                log('warning', "No authentication token available")
                return jsonify({'error': 'No authentication token available'}), 401
            
            # Skip MLflow SDK entirely - go straight to REST API which is more reliable
            # MLflow SDK has internal int() parsing bugs with some version formats
            import requests as req
            
            prompt = None
            load_error = None
            template = None
            prompt_version = None
            
            log('info', f"Loading prompt template via REST API: {full_name}, alias={alias}, version={version}")
            
            # Use REST API directly - more reliable than MLflow SDK
            headers = {
                'Authorization': f'Bearer {token}',
                'Content-Type': 'application/json',
            }
            
            try:
                # First, get prompt metadata to find the latest version and aliases
                prompt_url = f"{host}/api/2.0/mlflow/unity-catalog/prompts/{full_name}"
                log('info', f"Calling REST API: GET {prompt_url}")
                prompt_response = req.get(prompt_url, headers=headers, timeout=30)
                
                log('info', f"Prompt metadata response: status={prompt_response.status_code}")
                
                if prompt_response.status_code != 200:
                    log('error', f"Prompt metadata error: {prompt_response.text[:500] if prompt_response.text else 'empty'}")
                    return jsonify({'error': f'Failed to get prompt metadata: {prompt_response.status_code}'}), prompt_response.status_code
                
                prompt_meta = prompt_response.json()
                
                # Get version count from tags
                tags_list = prompt_meta.get('tags', [])
                version_count = 1
                for t in tags_list:
                    if t.get('key') == 'PromptVersionCount':
                        try:
                            version_count = int(t.get('value', '1'))
                        except (ValueError, TypeError):
                            version_count = 1
                        break
                
                # Get aliases
                aliases_list = prompt_meta.get('aliases', [])
                alias_version_map: dict[str, str] = {}
                for a in aliases_list:
                    alias_name = a.get('alias', '')
                    alias_ver = a.get('version', '')
                    if alias_name and alias_ver:
                        alias_version_map[alias_name] = alias_ver
                
                log('info', f"Prompt metadata: version_count={version_count}, aliases={list(alias_version_map.keys())}")
                
                # Determine which version to load
                target_version_num: int | None = None
                
                if version:
                    # Use specific version
                    target_version_num = int(version)
                elif alias and alias in alias_version_map:
                    # Use aliased version
                    target_version_num = int(alias_version_map[alias])
                elif alias == 'latest' or not alias:
                    # Use latest version (highest version number)
                    target_version_num = version_count
                elif alias in ['champion', 'default']:
                    # Check if these aliases exist
                    if alias in alias_version_map:
                        target_version_num = int(alias_version_map[alias])
                    else:
                        return jsonify({
                            'error': f"Alias '{alias}' not found for prompt {full_name}",
                            'alias_not_found': True
                        }), 404
                
                if not target_version_num:
                    target_version_num = version_count
                
                log('info', f"Loading version {target_version_num} for prompt {full_name}")
                
                # Use MLflow SDK to load the specific version
                import mlflow
                mlflow.set_tracking_uri("databricks")
                
                os.environ['DATABRICKS_HOST'] = normalize_host(host)
                os.environ['DATABRICKS_TOKEN'] = token
                
                prompt_uri = f"prompts:/{full_name}/{target_version_num}"
                log('info', f"Loading prompt with MLflow SDK: {prompt_uri}")
                
                try:
                    prompt_obj = mlflow.genai.load_prompt(prompt_uri)
                    template = prompt_obj.template if prompt_obj else ''
                    loaded_version = str(prompt_obj.version) if prompt_obj and prompt_obj.version else str(target_version_num)
                    
                    result = {
                        'template': template,
                        'version': loaded_version,
                        'name': full_name,
                        'alias': alias if alias else None,
                    }
                    
                    log('info', f"Successfully loaded template for {full_name}, version={loaded_version}")
                    return jsonify(result)
                    
                except Exception as mlflow_err:
                    log('error', f"MLflow load_prompt error: {mlflow_err}")
                    return jsonify({'error': str(mlflow_err)}), 500
                    
            except Exception as rest_err:
                log('error', f"REST API error: {rest_err}")
                import traceback
                log('error', f"Traceback: {traceback.format_exc()}")
                return jsonify({'error': str(rest_err)}), 500
                    
        finally:
            # Restore original environment variables
            for var in env_vars_to_manage:
                if orig_env[var] is not None:
                    os.environ[var] = orig_env[var]
                elif var in os.environ:
                    del os.environ[var]
        
    except Exception as e:
        import traceback
        log('error', f"Error getting prompt template for {full_name}: {e}")
        log('error', f"Traceback: {traceback.format_exc()}")
        return jsonify({'error': str(e)}), 500


@app.route('/api/uc/register-prompt', methods=['POST'])
def register_prompt():
    """Register a new prompt in the MLflow Prompt Registry.
    
    JSON body:
    - name: The prompt name (will be combined with catalog.schema) (required)
    - catalog_name: The catalog name (required)
    - schema_name: The schema name (required)
    - template: The prompt template content (required)
    - description: Description/commit message for the prompt (optional)
    - alias: Alias to set for the new version (optional, e.g., 'champion', 'default')
    - tags: Optional tags dict (optional)
    - service_principal: Optional service principal config for authentication
    
    Returns the registered prompt info including version number.
    """
    data = request.get_json() or {}
    name = data.get('name')
    catalog_name = data.get('catalog_name')
    schema_name = data.get('schema_name')
    template = data.get('template')
    description = data.get('description', '')
    alias = data.get('alias')
    tags = data.get('tags', {})
    service_principal = data.get('service_principal')
    
    # Validate required fields
    if not name:
        return jsonify({'error': 'name parameter required'}), 400
    if not catalog_name:
        return jsonify({'error': 'catalog_name parameter required'}), 400
    if not schema_name:
        return jsonify({'error': 'schema_name parameter required'}), 400
    if not template:
        return jsonify({'error': 'template parameter required'}), 400
    
    # Build full prompt name
    full_name = f"{catalog_name}.{schema_name}.{name}"
    
    try:
        log('info', f"Registering prompt: {full_name}")
        
        # Get host
        host, host_source = get_databricks_host_with_source()
        
        if not host:
            log('warning', f"No Databricks host available.")
            return jsonify({
                'error': 'No Databricks host configured',
            }), 401
        
        # Normalize host
        host = host.rstrip('/')
        
        # Determine which credentials to use for SP auth
        sp_client_id: str | None = None
        sp_client_secret: str | None = None
        use_sp_auth: bool = False
        
        if service_principal:
            log('info', f"Using service principal for prompt registration")
            obo_token, _ = get_databricks_token_with_source()
            sp_client_id, sp_client_secret = get_service_principal_credentials(
                service_principal, obo_token
            )
            if sp_client_id and sp_client_secret:
                use_sp_auth = True
                log('info', f"Resolved service principal credentials: client_id={sp_client_id[:8]}...")
        
        # Save original environment variables to restore later
        orig_env: dict[str, str | None] = {}
        env_vars_to_manage = ['DATABRICKS_HOST', 'DATABRICKS_TOKEN', 'DATABRICKS_CLIENT_ID', 'DATABRICKS_CLIENT_SECRET']
        for var in env_vars_to_manage:
            orig_env[var] = os.environ.get(var)
        
        try:
            # Clear all auth-related env vars first
            for var in env_vars_to_manage:
                if var in os.environ:
                    del os.environ[var]
            
            # Set DATABRICKS_HOST (ensure https:// scheme)
            os.environ['DATABRICKS_HOST'] = normalize_host(host)
            
            if use_sp_auth:
                # Use service principal authentication
                os.environ['DATABRICKS_CLIENT_ID'] = sp_client_id
                os.environ['DATABRICKS_CLIENT_SECRET'] = sp_client_secret
                log('info', f"Set DATABRICKS_CLIENT_ID and DATABRICKS_CLIENT_SECRET for SP auth")
            else:
                # Fall back to user's token
                token, token_source = get_databricks_token_with_source()
                if token:
                    os.environ['DATABRICKS_TOKEN'] = token
                    log('info', f"Set DATABRICKS_TOKEN from {token_source}")
                else:
                    log('warning', "No authentication token available")
                    return jsonify({'error': 'No authentication token available'}), 401
            
            # Use MLflow SDK to register the prompt
            import mlflow
            mlflow.set_tracking_uri("databricks")
            
            log('info', f"Registering prompt with MLflow SDK: {full_name}")
            
            # Prepare tags
            prompt_tags = dict(tags) if tags else {}
            prompt_tags['dao_ai_builder'] = 'true'  # Mark as created by the builder
            
            # Register the prompt
            commit_message = description or f"Registered via DAO AI Builder"
            prompt_version = mlflow.genai.register_prompt(
                name=full_name,
                template=template,
                commit_message=commit_message,
                tags=prompt_tags,
            )
            
            log('info', f"Successfully registered prompt '{full_name}' version {prompt_version.version}")
            
            # Set alias if specified
            aliases_set: list[str] = []
            if alias:
                try:
                    mlflow.genai.set_prompt_alias(
                        name=full_name,
                        alias=alias,
                        version=prompt_version.version,
                    )
                    aliases_set.append(alias)
                    log('info', f"Set alias '{alias}' for prompt version {prompt_version.version}")
                except Exception as alias_err:
                    log('warning', f"Failed to set alias '{alias}': {alias_err}")
            
            # Always try to set 'latest' alias as well
            try:
                mlflow.genai.set_prompt_alias(
                    name=full_name,
                    alias='latest',
                    version=prompt_version.version,
                )
                aliases_set.append('latest')
                log('info', f"Set 'latest' alias for prompt version {prompt_version.version}")
            except Exception as latest_err:
                log('warning', f"Failed to set 'latest' alias: {latest_err}")
            
            result = {
                'success': True,
                'name': name,
                'full_name': full_name,
                'version': prompt_version.version,
                'aliases': aliases_set,
                'message': f"Successfully registered prompt '{full_name}' version {prompt_version.version}",
            }
            
            return jsonify(result)
            
        finally:
            # Restore original environment variables
            for var in env_vars_to_manage:
                if orig_env[var] is not None:
                    os.environ[var] = orig_env[var]
                elif var in os.environ:
                    del os.environ[var]
        
    except Exception as e:
        import traceback
        log('error', f"Error registering prompt {full_name}: {e}")
        log('error', f"Traceback: {traceback.format_exc()}")
        return jsonify({'error': str(e)}), 500


@app.route('/api/uc/genie-spaces')
def list_genie_spaces():
    """List Genie spaces/rooms using user's token for proper permissions.
    
    Uses the user's OBO token (or other auth) to fetch Genie spaces the USER has access to,
    not just what the app's service principal can see.
    
    Returns all available Genie spaces (with pagination), sorted alphabetically by title.
    """
    try:
        current_user = get_current_user_email()
        log('info', f"Listing Genie spaces for user: {current_user}")
        
        # Get user's token and host - this respects the auth priority:
        # 1. OAuth session token
        # 2. Authorization header (manual PAT)
        # 3. X-Forwarded-Access-Token (OBO)
        # 4. SDK config / env vars
        token, token_source = get_databricks_token_with_source()
        host, _ = get_databricks_host_with_source()
        
        if not token or not host:
            log('error', "No token or host available for Genie spaces API")
            return jsonify({'error': 'Authentication required'}), 401
        
        log('info', f"Using {token_source} token for Genie spaces API")
        
        result = []
        headers = {'Authorization': f'Bearer {token}'}
        
        # Use REST API directly with user's token for proper permissions
        page_token = None
        page_count = 0
        max_pages = 100  # Safety limit
        
        while page_count < max_pages:
            page_count += 1
            api_url = f"{host}/api/2.0/genie/spaces?page_size=100"
            if page_token:
                api_url += f"&page_token={page_token}"
            
            log('info', f"Page {page_count}: Calling Genie spaces API with {token_source} token")
            
            try:
                resp = http_requests.get(api_url, headers=headers, timeout=30)
                log('info', f"Genie spaces API response status: {resp.status_code}")
                
                if resp.status_code == 200:
                    data = resp.json()
                    spaces = data.get('spaces', [])
                    log('info', f"Page {page_count}: API returned {len(spaces)} spaces")
                    
                    for s in spaces:
                        result.append({
                            'space_id': s.get('space_id') or s.get('id'),
                            'title': s.get('title') or s.get('name'),
                            'description': s.get('description') or '',
                            'warehouse_id': s.get('warehouse_id'),
                        })
                    
                    # Check for next page
                    page_token = data.get('next_page_token')
                    if not page_token:
                        break
                elif resp.status_code == 401 or resp.status_code == 403:
                    log('warning', f"Auth failed with {token_source} token: {resp.status_code}")
                    # If user token fails, try falling back to SDK method
                    break
                else:
                    log('error', f"Genie spaces API failed: {resp.status_code} - {resp.text}")
                    break
            except Exception as req_err:
                log('error', f"Request error: {req_err}")
                break
        
        log('info', f"Total Genie spaces from user token: {len(result)} (across {page_count} pages)")
        
        # If we got no results and the token wasn't working, try SDK fallback
        if len(result) == 0:
            log('info', "No results from user token, trying SDK fallback...")
            try:
                w = get_workspace_client()
                if hasattr(w, 'genie') and hasattr(w.genie, 'list_spaces'):
                    page_token = None
                    page_count = 0
                    
                    while page_count < max_pages:
                        page_count += 1
                        response = w.genie.list_spaces(page_size=100, page_token=page_token)
                        spaces = response.spaces or []
                        log('info', f"SDK Page {page_count}: returned {len(spaces)} spaces")
                        
                        for s in spaces:
                            result.append({
                                'space_id': s.space_id,
                                'title': s.title,
                                'description': getattr(s, 'description', None) or '',
                                'warehouse_id': getattr(s, 'warehouse_id', None),
                            })
                        
                        page_token = getattr(response, 'next_page_token', None)
                        if not page_token:
                            break
                    
                    log('info', f"Total Genie spaces from SDK: {len(result)}")
            except Exception as sdk_err:
                log('warning', f"SDK fallback also failed: {sdk_err}")
        
        # Sort alphabetically by title
        result.sort(key=lambda space: (space.get('title') or '').lower())
        
        log('info', f"Returning {len(result)} Genie spaces (sorted alphabetically)")
        return jsonify({'spaces': result, 'current_user': current_user})
    except Exception as e:
        log('error', f"Error listing Genie spaces: {e}")
        import traceback
        log('error', traceback.format_exc())
        return jsonify({'error': str(e)}), 500


@app.route('/api/uc/apps')
def list_apps():
    """List Databricks Apps using WorkspaceClient."""
    try:
        w = get_workspace_client()
        current_user = get_current_user_email()
        log('info', f"Listing apps for user: {current_user}")
        
        apps = list(w.apps.list())
        result = [
            {
                'name': app.name,
                'url': app.url,
                'description': getattr(app, 'description', None),
                'creator': getattr(app, 'creator', None),
                'create_time': getattr(app, 'create_time', None),
                'app_status': {
                    'state': app.app_status.state.value if app.app_status and app.app_status.state else None,
                    'message': getattr(app.app_status, 'message', None) if app.app_status else None,
                } if hasattr(app, 'app_status') and app.app_status else None,
                'compute_status': {
                    'state': app.compute_status.state.value if app.compute_status and app.compute_status.state else None,
                    'message': getattr(app.compute_status, 'message', None) if app.compute_status else None,
                } if hasattr(app, 'compute_status') and app.compute_status else None,
            }
            for app in apps
        ]
        log('info', f"Listed {len(result)} Databricks Apps")
        return jsonify({'apps': result, 'current_user': current_user})
    except Exception as e:
        log('error', f"Error listing Databricks Apps: {e}")
        import traceback
        log('error', traceback.format_exc())
        return jsonify({'error': str(e)}), 500


@app.route('/api/uc/databases')
def list_databases():
    """List Lakebase/PostgreSQL databases using WorkspaceClient."""
    try:
        w = get_workspace_client()
        current_user = get_current_user_email()
        log('debug', f"Listing databases for user: {current_user}")
        
        result = []
        
        try:
            # Try to list database instances (Lakebase)
            if hasattr(w, 'database') and hasattr(w.database, 'list_database_instances'):
                instances = list(w.database.list_database_instances())
                result = [
                    {
                        'name': db.name,
                        'state': db.state.value if hasattr(db, 'state') and db.state else None,
                        'creator': getattr(db, 'creator', None),
                        'owner': getattr(db, 'owner', None) or getattr(db, 'creator', None),
                        'read_write_dns': getattr(db, 'read_write_dns', None),
                    }
                    for db in instances
                ]
                log('info', f"Listed {len(result)} database instances via database.list_database_instances()")
        except Exception as e1:
            log('debug', f"database.list_database_instances() failed: {e1}")
            
            try:
                # Try alternative API - list_databases
                if hasattr(w, 'databases') and hasattr(w.databases, 'list'):
                    dbs = list(w.databases.list())
                    result = [
                        {
                            'name': db.name,
                            'state': getattr(db, 'state', None),
                            'creator': getattr(db, 'creator', None),
                            'owner': getattr(db, 'owner', None) or getattr(db, 'creator', None),
                        }
                        for db in dbs
                    ]
                    log('info', f"Listed {len(result)} databases via databases.list()")
            except Exception as e2:
                log('debug', f"databases.list() failed: {e2}")
        
        # Sort by owner (current user's databases first)
        result = sort_by_owner(result, current_user)
        
        return jsonify({'databases': result, 'current_user': current_user})
    except Exception as e:
        log('error', f"Error listing databases: {e}")
        return jsonify({'error': str(e)}), 500


@app.route('/api/uc/connections')
def list_uc_connections():
    """List Unity Catalog connections using WorkspaceClient."""
    try:
        w = get_workspace_client()
        current_user = get_current_user_email()
        log('debug', f"Listing UC connections for user: {current_user}")
        
        result = []
        try:
            connections = list(w.connections.list())
            result = [
                {
                    'name': c.name,
                    'connection_type': c.connection_type.value if hasattr(c, 'connection_type') and c.connection_type else None,
                    'owner': getattr(c, 'owner', None),
                    'comment': getattr(c, 'comment', None),
                    'full_name': getattr(c, 'full_name', None),
                }
                for c in connections
            ]
            log('info', f"Listed {len(result)} UC connections")
        except Exception as e:
            log('debug', f"connections.list() failed: {e}")
        
        # Sort by owner (current user's connections first)
        result = sort_by_owner(result, current_user)
        
        return jsonify({'connections': result, 'current_user': current_user})
    except Exception as e:
        log('error', f"Error listing UC connections: {e}")
        return jsonify({'error': str(e)}), 500


@app.route('/api/uc/serving-endpoints')
def list_serving_endpoints():
    """List serving endpoints using WorkspaceClient."""
    try:
        w = get_workspace_client()
        endpoints = list(w.serving_endpoints.list())
        result = [
            {
                'name': e.name,
                'state': {
                    'ready': e.state.ready.value if e.state and e.state.ready else None,
                    'config_update': e.state.config_update.value if e.state and e.state.config_update else None,
                } if e.state else None,
                'creator': e.creator,
            }
            for e in endpoints
        ]
        log('info', f"Listed {len(result)} serving endpoints")
        return jsonify({'endpoints': result})
    except Exception as e:
        log('error', f"Error listing serving endpoints: {e}")
        return jsonify({'error': str(e)}), 500


@app.route('/api/uc/sql-warehouses')
def list_sql_warehouses():
    """List SQL warehouses using WorkspaceClient."""
    try:
        w = get_workspace_client()
        warehouses = list(w.warehouses.list())
        result = [
            {
                'id': wh.id,
                'name': wh.name,
                'state': wh.state.value if wh.state else None,
                'cluster_size': wh.cluster_size,
                'num_clusters': wh.num_clusters,
            }
            for wh in warehouses
        ]
        
        # Sort warehouses: RUNNING first, then STARTING/STOPPING, then STOPPED, then others
        state_priority = {
            'RUNNING': 0,
            'STARTING': 1,
            'STOPPING': 2,
            'STOPPED': 3,
            'DELETED': 4,
            'DELETING': 5,
        }
        result.sort(key=lambda x: (state_priority.get(x.get('state'), 99), x.get('name', '')))
        
        log('info', f"Listed {len(result)} SQL warehouses")
        return jsonify({'warehouses': result})
    except Exception as e:
        log('error', f"Error listing SQL warehouses: {e}")
        return jsonify({'error': str(e)}), 500


@app.route('/api/uc/vector-search-endpoints')
def list_vector_search_endpoints():
    """List vector search endpoints using WorkspaceClient."""
    try:
        w = get_workspace_client()
        # Vector search API might not be available
        try:
            endpoints = list(w.vector_search_endpoints.list_endpoints())
            result = [
                {
                    'name': e.name,
                    'endpoint_type': e.endpoint_type.value if e.endpoint_type else None,
                    'endpoint_status': {
                        'state': e.endpoint_status.state.value if e.endpoint_status and e.endpoint_status.state else None,
                    } if e.endpoint_status else None,
                }
                for e in endpoints
            ]
            log('info', f"Listed {len(result)} vector search endpoints")
            return jsonify({'endpoints': result})
        except AttributeError:
            log('warning', "Vector search API not available in this SDK version")
            return jsonify({'endpoints': [], 'warning': 'Vector search API not available'})
    except Exception as e:
        log('error', f"Error listing vector search endpoints: {e}")
        return jsonify({'error': str(e)}), 500


@app.route('/api/uc/vector-search-indexes')
def list_vector_search_indexes():
    """
    List vector search indexes.
    
    Query params:
    - endpoint (optional): Filter by endpoint name. If not provided, returns all indexes.
    """
    endpoint = request.args.get('endpoint')
    
    log('debug', f"Listing vector search indexes" + (f" for endpoint: {endpoint}" if endpoint else " (all)"))
    
    try:
        w = get_workspace_client()
        
        # Get all vector search endpoints first, then fetch indexes for each
        all_indexes = []
        
        if endpoint:
            # Filter to specific endpoint
            endpoints_to_check = [endpoint]
        else:
            # Get all endpoints
            try:
                endpoints_list = list(w.vector_search_endpoints.list_endpoints())
                endpoints_to_check = [ep.name for ep in endpoints_list if ep.name]
                log('debug', f"Found {len(endpoints_to_check)} endpoints to check for indexes")
            except Exception as e:
                log('warning', f"Could not list endpoints: {e}")
                endpoints_to_check = []
        
        # Fetch indexes for each endpoint
        for ep_name in endpoints_to_check:
            try:
                indexes = list(w.vector_search_indexes.list_indexes(endpoint_name=ep_name))
                for idx in indexes:
                    index_info = {
                        'name': idx.name,
                        'endpoint_name': idx.endpoint_name or ep_name,
                        'index_type': idx.index_type.value if idx.index_type else None,
                        'primary_key': idx.primary_key,
                        'status': None,
                    }
                    
                    # Get status if available
                    if hasattr(idx, 'status') and idx.status:
                        status = idx.status
                        if hasattr(status, 'ready'):
                            index_info['status'] = 'READY' if status.ready else 'NOT_READY'
                        elif isinstance(status, dict):
                            index_info['status'] = status.get('message', str(status))
                        else:
                            index_info['status'] = str(status)
                    
                    # Extract source table info from delta_sync_index_spec
                    if idx.delta_sync_index_spec:
                        spec = idx.delta_sync_index_spec
                        source_table = getattr(spec, 'source_table', None)
                        
                        index_info['delta_sync_index_spec'] = {
                            'source_table': source_table,
                            'pipeline_type': spec.pipeline_type.value if spec.pipeline_type else None,
                        }
                        
                        # Extract embedding source columns
                        if spec.embedding_source_columns:
                            index_info['delta_sync_index_spec']['embedding_source_columns'] = [
                                {
                                    'name': col.name,
                                    'embedding_model_endpoint_name': getattr(col, 'embedding_model_endpoint_name', None),
                                }
                                for col in spec.embedding_source_columns
                            ]
                        
                        # Extract columns to sync
                        if getattr(spec, 'columns_to_sync', None):
                            index_info['delta_sync_index_spec']['columns_to_sync'] = spec.columns_to_sync
                    
                    # Extract info from direct_access_index_spec if available
                    if idx.direct_access_index_spec:
                        spec = idx.direct_access_index_spec
                        index_info['direct_access_index_spec'] = {
                            'embedding_source_columns': [
                                {
                                    'name': col.name,
                                    'embedding_model_endpoint_name': getattr(col, 'embedding_model_endpoint_name', None),
                                }
                                for col in (spec.embedding_source_columns or [])
                            ] if spec.embedding_source_columns else None,
                            'schema_json': getattr(spec, 'schema_json', None),
                        }
                    
                    all_indexes.append(index_info)
                    
            except AttributeError:
                # Some index types (e.g., MiniVectorIndex) don't have delta_sync_index_spec - skip silently
                pass
            except Exception as e:
                log('warning', f"Error fetching indexes for endpoint {ep_name}: {e}")
        
        log('info', f"Listed {len(all_indexes)} vector search indexes" + (f" for endpoint {endpoint}" if endpoint else ""))
        return jsonify({'vector_indexes': all_indexes})
        
    except Exception as e:
        log('error', f"Error listing vector search indexes: {e}")
        import traceback
        log('error', traceback.format_exc())
        return jsonify({'error': str(e)}), 500


@app.route('/api/mcp/list-tools', methods=['POST'])
def list_mcp_tools_endpoint():
    """
    List available tools from an MCP server.
    
    This endpoint accepts an MCP function configuration and returns
    the list of available tools from the server.
    
    Request body should contain the MCP configuration:
    - url: Direct URL to MCP server
    - sql: Boolean for SQL MCP
    - genie_room: Genie room configuration
    - vector_search: Vector search configuration
    - functions: Schema for UC functions
    - connection: UC connection name
    
    Returns:
    - tools: List of tool info objects with name, description, input_schema
    """
    try:
        from dao_ai.config import McpFunctionModel
        from dao_ai.tools.mcp import list_mcp_tools
    except ImportError as e:
        log('error', f'dao-ai package not installed: {e}')
        return jsonify({
            'error': f'dao-ai package not installed: {str(e)}',
            'tools': []
        }), 500
    
    try:
        config = request.get_json()
        if not config:
            return jsonify({'error': 'No configuration provided', 'tools': []}), 400
        
        # Log the full request for debugging
        log('info', f'MCP list-tools request received')
        log('debug', f'MCP request keys: {list(config.keys())}')
        log('debug', f'MCP request app: {config.get("app")}')
        log('debug', f'MCP request has client_id: {bool(config.get("client_id"))}')
        log('debug', f'MCP request has client_secret: {bool(config.get("client_secret"))}')
        log('debug', f'MCP request workspace_host: {config.get("workspace_host")}')
        
        # Get workspace client for authentication
        w = get_workspace_client()
        
        # Build the McpFunctionModel from the request
        # Note: 'name' is not part of McpFunctionModel, it's part of ToolModel
        mcp_config = {
            'type': 'mcp',
        }
        
        # Add optional fields if present
        if config.get('url'):
            mcp_config['url'] = config['url']
        if config.get('sql'):
            mcp_config['sql'] = config['sql']
        if config.get('genie_room'):
            mcp_config['genie_room'] = config['genie_room']
        if config.get('vector_search'):
            mcp_config['vector_search'] = config['vector_search']
        if config.get('functions'):
            mcp_config['functions'] = config['functions']
        if config.get('connection'):
            mcp_config['connection'] = config['connection']
            # Log connection details for debugging UC Connection MCP
            conn_config = config['connection']
            conn_name = conn_config.get('name') if isinstance(conn_config, dict) else conn_config
            log('debug', f'UC Connection MCP: connection_name={conn_name}')
            # The MCP URL will be: {workspace_host}/api/2.0/mcp/external/{connection_name}
        if config.get('app'):
            # Resolve the app URL here in the builder, not in dao-ai
            # This ensures we use the correct credentials and don't depend on dao-ai version
            app_config = config['app']
            if isinstance(app_config, dict) and app_config.get('name'):
                app_name = app_config['name']
                log('debug', f'Resolving URL for Databricks App: {app_name}')
                
                # Build a workspace client with appropriate credentials for URL resolution
                url_resolution_client = None
                
                # Check for credentials (client_id/secret or PAT)
                if config.get('client_id') and config.get('client_secret'):
                    try:
                        from databricks.sdk import WorkspaceClient
                        host = config.get('workspace_host') or w.config.host
                        if host and not host.startswith('http://') and not host.startswith('https://'):
                            host = f'https://{host}'
                        log('debug', f'Creating WorkspaceClient with OAuth credentials for app URL resolution, host={host}')
                        url_resolution_client = WorkspaceClient(
                            host=host,
                            client_id=config['client_id'],
                            client_secret=config['client_secret'],
                        )
                    except Exception as auth_err:
                        log('warning', f'Failed to create client with OAuth credentials: {auth_err}')
                
                # Fall back to ambient workspace client
                if not url_resolution_client:
                    log('debug', 'Using ambient credentials for app URL resolution')
                    url_resolution_client = w
                
                try:
                    app_details = url_resolution_client.apps.get(name=app_name)
                    log('debug', f'Got app details: url={app_details.url}, status={app_details.status}')
                    if app_details and app_details.url:
                        # Set URL at MCP function level - append /mcp suffix
                        mcp_url = app_details.url.rstrip('/') + '/mcp'
                        mcp_config['url'] = mcp_url
                        log('info', f'Resolved app MCP URL: {mcp_url}')
                    else:
                        log('warning', f'App {app_name} found but has no URL. Is it deployed?')
                        return jsonify({'error': f'App {app_name} has no URL. Is it deployed?'}), 400
                except Exception as app_err:
                    log('error', f'Failed to resolve app URL for {app_name}: {app_err}')
                    return jsonify({'error': f'Failed to resolve app URL: {str(app_err)}'}), 400
        
        # Add authentication fields if present
        # These are inherited from IsDatabricksResource on McpFunctionModel
        if config.get('service_principal'):
            mcp_config['service_principal'] = config['service_principal']
        if config.get('client_id'):
            mcp_config['client_id'] = config['client_id']
        if config.get('client_secret'):
            mcp_config['client_secret'] = config['client_secret']
        if config.get('workspace_host'):
            host = config['workspace_host']
            # Ensure host has https:// prefix
            if host and not host.startswith('http://') and not host.startswith('https://'):
                host = f'https://{host}'
            mcp_config['workspace_host'] = host
            log('debug', f'Using provided workspace host for OAuth: {host}')
        elif config.get('client_id') or config.get('client_secret'):
            # If credentials are provided but no workspace_host, use the backend's host
            # This is required for OAuth token endpoint construction
            host = w.config.host
            # Ensure host has https:// prefix
            if host and not host.startswith('http://') and not host.startswith('https://'):
                host = f'https://{host}'
            mcp_config['workspace_host'] = host
            log('debug', f'Using backend workspace host for OAuth: {host}')
        if config.get('pat'):
            mcp_config['pat'] = config['pat']
        if config.get('on_behalf_of_user'):
            mcp_config['on_behalf_of_user'] = config['on_behalf_of_user']
        
        # Add include/exclude tools if provided (for filtering)
        if config.get('include_tools'):
            mcp_config['include_tools'] = config['include_tools']
        if config.get('exclude_tools'):
            mcp_config['exclude_tools'] = config['exclude_tools']
        
        # Log config (mask secrets)
        safe_config = {k: ('***' if 'secret' in k.lower() else v) for k, v in mcp_config.items()}
        log('debug', f'Creating McpFunctionModel with config: {safe_config}')
        
        # Determine what MCP source is configured
        url_info = mcp_config.get("url")
        mcp_source = 'url' if url_info else None
        if not mcp_source and mcp_config.get("genie_room"):
            mcp_source = 'genie_room'
        if not mcp_source and mcp_config.get("sql"):
            mcp_source = 'sql'
        if not mcp_source and mcp_config.get("connection"):
            mcp_source = 'connection'
        if not mcp_source and mcp_config.get("vector_search"):
            mcp_source = 'vector_search'
        if not mcp_source and mcp_config.get("functions"):
            mcp_source = 'functions'
        
        log('info', f'MCP source: {mcp_source}, url: {url_info}, workspace_host: {mcp_config.get("workspace_host")}, has_client_id: {bool(mcp_config.get("client_id"))}, has_client_secret: {bool(mcp_config.get("client_secret"))}')
        
        # Validate that we have a valid MCP source
        if not mcp_source:
            log('error', f'No valid MCP source configured. Request config: {json.dumps(config, default=str)}')
            return jsonify({'error': 'No valid MCP source configured. Please provide url, app, genie_room, sql, connection, vector_search, or functions.'}), 400
        
        # Additional logging for UC Connection to help debug
        if mcp_config.get('connection'):
            conn = mcp_config['connection']
            conn_name = conn.get('name') if isinstance(conn, dict) else conn
            ws_host = mcp_config.get('workspace_host') or w.config.host
            expected_url = f'{ws_host}/api/2.0/mcp/external/{conn_name}'
            log('info', f'UC Connection expected MCP URL: {expected_url}')
        
        # Create the MCP function model
        mcp_function = McpFunctionModel(**mcp_config)
        
        # Note: The dao-ai library's IsDatabricksResource.workspace_client property
        # creates a new WorkspaceClient with ambient auth on each access.
        # This should work in the Databricks App context for all resource types.
        
        # List available tools
        tools = list_mcp_tools(mcp_function, apply_filters=False)
        
        # Convert to serializable format
        tools_list = [
            {
                'name': tool.name,
                'description': tool.description,
                'input_schema': tool.input_schema,
            }
            for tool in tools
        ]
        
        log('info', f'Listed {len(tools_list)} MCP tools')
        return jsonify({'tools': tools_list})
        
    except Exception as e:
        log('error', f'Error listing MCP tools: {e}')
        import traceback
        log('error', traceback.format_exc())
        
        # Try to extract more detail from ExceptionGroup (Python 3.11+)
        error_detail = str(e)
        if hasattr(e, '__cause__') and e.__cause__:
            cause = e.__cause__
            if hasattr(cause, 'exceptions'):
                # ExceptionGroup - get sub-exceptions
                for sub_exc in cause.exceptions:
                    log('error', f'Sub-exception: {type(sub_exc).__name__}: {sub_exc}')
                    error_detail = f"{error_detail} | {type(sub_exc).__name__}: {sub_exc}"
            else:
                log('error', f'Cause: {type(cause).__name__}: {cause}')
                error_detail = f"{error_detail} | Cause: {cause}"
        
        return jsonify({
            'error': error_detail,
            'tools': []
        }), 500


@app.route('/api/auth/verify')
def verify_auth():
    """
    Verify authentication by making a test API call or using forwarded headers.
    
    If an Authorization header is provided, it will test that specific token.
    Otherwise, it uses OBO auth or auto-detected credentials.
    """
    log('debug', "=== AUTH VERIFY REQUEST ===")
    
    # Check if a manual token is being tested (from Authorization header)
    auth_header = request.headers.get('Authorization', '')
    manual_host = request.headers.get('X-Databricks-Host')
    
    if auth_header.startswith('Bearer '):
        # Testing a specific manual token
        token = auth_header[7:]
        token_source = 'manual'
        host = normalize_host(manual_host) if manual_host else None
        host_source = 'header' if manual_host else None
        log('info', f"Verifying MANUAL token (length: {len(token)}, host: {host})")
        
        if not host:
            # Try to get host from other sources
            host, host_source = get_databricks_host_with_source()
        
        if not host:
            return jsonify({
                'authenticated': False,
                'error': 'No Databricks host provided',
                'help': 'Include X-Databricks-Host header with the request',
            }), 400
        
        # Test the manual token directly
        try:
            resp = http_requests.get(
                f"{host}/api/2.0/sql/warehouses",
                headers={'Authorization': f'Bearer {token}'},
                timeout=10,
            )
            
            log('debug', f"Manual token test response: {resp.status_code}")
            
            if resp.ok:
                # Token works, try to get user info
                user_data = None
                try:
                    user_resp = http_requests.get(
                        f"{host}/api/2.0/preview/scim/v2/Me",
                        headers={'Authorization': f'Bearer {token}'},
                        timeout=10,
                    )
                    if user_resp.ok:
                        user_data = user_resp.json()
                        log('debug', f"SCIM response: {user_data}")
                except Exception as e:
                    log('warning', f"SCIM call failed: {e}")
                
                return jsonify({
                    'authenticated': True,
                    'token_source': token_source,
                    'host_source': host_source,
                    'host': host,
                    'user': {
                        'userName': user_data.get('userName') if user_data else 'authenticated_user',
                        'displayName': user_data.get('displayName') if user_data else 'Authenticated User',
                        'emails': user_data.get('emails', []) if user_data else [],
                    },
                })
            else:
                try:
                    error_data = resp.json()
                except Exception:
                    error_data = {'message': resp.text[:200]}
                
                error_msg = error_data.get('message', '') or error_data.get('error', '') or resp.text[:200]
                log('warning', f"Manual token verification failed: {resp.status_code} - {error_msg}")
                
                return jsonify({
                    'authenticated': False,
                    'error': f"Token validation failed: {error_msg}",
                    'status_code': resp.status_code,
                    'token_source': token_source,
                }), resp.status_code
                
        except Exception as e:
            log('error', f"Manual token verification error: {e}")
            return jsonify({
                'authenticated': False,
                'error': str(e),
                'token_source': token_source,
            }), 500
    
    # No manual token provided - use auto-detection
    token, token_source = get_databricks_token_with_source()
    host, host_source = get_databricks_host_with_source()
    
    log('debug', f"Auto-detect auth: token_source={token_source}, host_source={host_source}")
    
    # Check for Databricks App forwarded user info
    # When running in a Databricks App with OBO auth, these headers contain user info
    forwarded_email = request.headers.get('X-Forwarded-Email')
    forwarded_username = request.headers.get('X-Forwarded-Preferred-Username')
    forwarded_user_id = request.headers.get('X-Forwarded-User')
    
    # If we have OBO auth with forwarded headers, we're authenticated
    if token_source == 'obo' and (forwarded_email or forwarded_username):
        log('info', f"OBO auth verified via headers: email={forwarded_email}, username={forwarded_username}")
        return jsonify({
            'authenticated': True,
            'token_source': token_source,
            'host_source': host_source,
            'host': host,
            'user': {
                'userName': forwarded_email or forwarded_username,
                'displayName': forwarded_username or forwarded_email,
                'emails': [{'value': forwarded_email}] if forwarded_email else [],
            },
            'auth_method': 'obo_headers',
        })
    
    if not token:
        return jsonify({
            'authenticated': False,
            'error': 'No authentication token available',
            'token_source': None,
            'help': 'The app needs either: (1) X-Forwarded-Access-Token from Databricks App, '
                   '(2) Manual PAT configuration, or (3) DATABRICKS_TOKEN environment variable.',
        }), 401
    
    if not host:
        return jsonify({
            'authenticated': False,
            'error': 'No Databricks host configured',
            'host_source': None,
        }), 400
    
    # For manual tokens or SDK auth, try to call an API to verify
    # Use the SQL warehouses list endpoint which has the 'sql' scope
    try:
        resp = http_requests.get(
            f"{host}/api/2.0/sql/warehouses",
            headers={'Authorization': f'Bearer {token}'},
            timeout=10,
        )
        
        if resp.ok:
            # Token works for SQL APIs, now try to get user info
            # Try SCIM /Me but don't fail if it doesn't work
            user_data = None
            try:
                user_resp = http_requests.get(
                    f"{host}/api/2.0/preview/scim/v2/Me",
                    headers={'Authorization': f'Bearer {token}'},
                    timeout=10,
                )
                if user_resp.ok:
                    user_data = user_resp.json()
            except Exception:
                pass  # SCIM might not be available, that's OK
            
            return jsonify({
                'authenticated': True,
                'token_source': token_source,
                'host_source': host_source,
                'host': host,
                'user': {
                    'userName': user_data.get('userName') if user_data else 'Unknown',
                    'displayName': user_data.get('displayName') if user_data else 'Authenticated User',
                    'emails': user_data.get('emails', []) if user_data else [],
                } if user_data else {
                    'userName': 'authenticated_user',
                    'displayName': 'Authenticated User',
                    'emails': [],
                },
            })
        else:
            # Try to parse error response
            try:
                error_data = resp.json()
            except Exception:
                error_data = {'message': resp.text}
            
            error_msg = error_data.get('message', '') or error_data.get('error', '') or resp.text
            
            # Check for scope errors
            if 'scope' in error_msg.lower():
                return jsonify({
                    'authenticated': False,
                    'error': error_msg,
                    'token_source': token_source,
                    'host_source': host_source,
                    'scope_error': True,
                    'required_scopes': ['sql'],
                    'configured_scopes': OAUTH_SCOPES,
                    'help': 'The OAuth token does not have the required scopes. '
                           'If using Databricks App with user authorization, the user may need to '
                           're-authorize the app. Try: (1) Sign out and sign back in, or '
                           '(2) Use a Personal Access Token instead.',
                }), 403
            
            return jsonify({
                'authenticated': False,
                'error': error_msg,
                'status_code': resp.status_code,
                'token_source': token_source,
                'host_source': host_source,
            }), resp.status_code
            
    except Exception as e:
        return jsonify({
            'authenticated': False,
            'error': str(e),
            'token_source': token_source,
            'host_source': host_source,
        }), 500


@app.route('/api/debug')
def debug_info():
    """Debug endpoint to check headers and config."""
    # Get all forwarded headers (safe to show names, not values)
    forwarded_headers = {
        k: ('***' if 'token' in k.lower() or 'secret' in k.lower() else v[:50] + '...' if len(str(v)) > 50 else v)
        for k, v in request.headers 
        if k.lower().startswith('x-forwarded') or k.lower().startswith('x-real')
    }
    
    token, source = get_databricks_token_with_source()
    host, host_source = get_databricks_host_with_source()
    
    return jsonify({
        'status': 'ok',
        'auth': {
            'token_source': source,
            'has_token': bool(token),
            'token_length': len(token) if token else 0,
            'host': host,
            'host_source': host_source,
        },
        'databricks_app_context': {
            'has_forwarded_token': bool(request.headers.get('X-Forwarded-Access-Token')),
            'has_forwarded_email': bool(request.headers.get('X-Forwarded-Email')),
            'forwarded_email': request.headers.get('X-Forwarded-Email'),
            'forwarded_user': request.headers.get('X-Forwarded-User'),
        },
        'forwarded_headers': forwarded_headers,
        'manual_auth': {
            'has_auth_header': bool(request.headers.get('Authorization')),
            'has_oauth_session': 'access_token' in session,
        },
        'environment': {
            'DATABRICKS_HOST': os.environ.get('DATABRICKS_HOST', 'not set'),
            'DATABRICKS_TOKEN': 'set' if os.environ.get('DATABRICKS_TOKEN') else 'not set',
            'DATABRICKS_CLIENT_ID': 'set' if os.environ.get('DATABRICKS_CLIENT_ID') else 'not set',
        },
        'configured_scopes': OAUTH_SCOPES,
    })


# =============================================================================
# Deployment APIs
# =============================================================================

# Track deployment status in memory (in production, use a database or distributed cache)
_deployment_status = {}
# Lock to protect status updates from race conditions between cancel endpoint and deployment thread
_deployment_status_lock = threading.Lock()

@app.route('/api/deploy/validate', methods=['POST'])
def validate_deployment():
    """Validate configuration before deployment.
    
    Request body:
    - config: The YAML configuration as a dictionary
    
    Returns validation results and deployment requirements.
    """
    try:
        import yaml
        import tempfile
        import os as os_module
        
        data = request.get_json()
        config = data.get('config')
        
        if not config:
            return jsonify({'error': 'config is required'}), 400
        
        # Check required fields for deployment
        errors = []
        warnings = []
        requirements = []
        
        app_config = config.get('app', {})
        
        # Check app name
        if not app_config.get('name'):
            errors.append('app.name is required')
        
        # Check registered model
        registered_model = app_config.get('registered_model')
        if not registered_model:
            errors.append('app.registered_model is required for deployment')
        else:
            if not registered_model.get('name'):
                errors.append('app.registered_model.name is required')
            if not registered_model.get('schema'):
                errors.append('app.registered_model.schema is required')
        
        # Check endpoint name (only for Model Serving deployments)
        deployment_target = app_config.get('deployment_target', 'model_serving')
        if deployment_target == 'model_serving' and not app_config.get('endpoint_name'):
            warnings.append('app.endpoint_name not set - will default to app name')
        
        # Check for agents
        agents = config.get('agents', {})
        if not agents or len(agents) == 0:
            errors.append('At least one agent is required')
        
        # Check for orchestration
        orchestration = app_config.get('orchestration', {})
        if not orchestration.get('supervisor') and not orchestration.get('swarm'):
            errors.append('Orchestration pattern (supervisor or swarm) is required')
        
        # Check for LLMs in resources
        resources = config.get('resources', {})
        llms = resources.get('llms', {})
        if not llms or len(llms) == 0:
            warnings.append('No LLMs configured in resources')
        
        # Determine requirements based on configuration
        if resources.get('vector_stores'):
            requirements.append({
                'type': 'vector_search',
                'description': 'Vector Search endpoints and indexes',
                'count': len(resources.get('vector_stores', {}))
            })
        
        if resources.get('genie_rooms'):
            requirements.append({
                'type': 'genie',
                'description': 'Genie Rooms',
                'count': len(resources.get('genie_rooms', {}))
            })
        
        if resources.get('databases'):
            requirements.append({
                'type': 'database',
                'description': 'Lakebase/PostgreSQL databases',
                'count': len(resources.get('databases', {}))
            })
        
        if resources.get('functions'):
            requirements.append({
                'type': 'functions',
                'description': 'Unity Catalog functions',
                'count': len(resources.get('functions', {}))
            })
        
        is_valid = len(errors) == 0
        
        # Dynamic deployment options based on deployment target
        if deployment_target == 'apps':
            deployment_options = {
                'quick': {
                    'description': 'Deploy model and app only (fast, ~2-5 min)',
                    'provisions': ['MLflow Model', 'Databricks App'],
                    'available': is_valid
                },
                'full': {
                    'description': 'Full pipeline with infrastructure (complete, ~10-30 min)',
                    'provisions': ['Data Ingestion', 'Vector Search', 'Lakebase', 'UC Functions', 'Model', 'Databricks App', 'Evaluation'],
                    'available': is_valid,
                    'requires_bundle': True
                }
            }
        else:  # model_serving
            deployment_options = {
                'quick': {
                    'description': 'Deploy model and endpoint only (fast, ~2-5 min)',
                    'provisions': ['MLflow Model', 'Model Serving Endpoint'],
                    'available': is_valid
                },
                'full': {
                    'description': 'Full pipeline with infrastructure (complete, ~10-30 min)',
                    'provisions': ['Data Ingestion', 'Vector Search', 'Lakebase', 'UC Functions', 'Model', 'Endpoint', 'Evaluation'],
                    'available': is_valid,
                    'requires_bundle': True
                }
            }
        
        return jsonify({
            'valid': is_valid,
            'errors': errors,
            'warnings': warnings,
            'requirements': requirements,
            'app_name': app_config.get('name'),
            'endpoint_name': app_config.get('endpoint_name') or app_config.get('name'),
            'agent_count': len(agents),
            'deployment_options': deployment_options
        })
        
    except Exception as e:
        import traceback
        log('error', f"Error validating deployment: {e}")
        log('error', f"Traceback: {traceback.format_exc()}")
        return jsonify({'error': str(e)}), 500


@app.route('/api/validate/schema', methods=['POST'])
def validate_schema():
    """Validate YAML configuration against dao_ai.config.AppConfig JSON schema.
    
    Uses AppConfig.model_json_schema() to generate the JSON schema and validates
    against it using jsonschema library. This avoids triggering model validators
    that make live API calls.
    
    Request body:
    - yaml_content: The YAML configuration as a string
    
    Returns validation results with detailed error messages.
    """
    import yaml as pyyaml
    import json
    
    try:
        data = request.get_json()
        yaml_content = data.get('yaml_content')
        
        if not yaml_content:
            return jsonify({'error': 'yaml_content is required'}), 400
        
        # Parse YAML first
        try:
            # Remove comment lines before parsing
            clean_yaml = '\n'.join(
                line for line in yaml_content.split('\n') 
                if not line.strip().startswith('#')
            )
            config_dict = pyyaml.safe_load(clean_yaml)
        except pyyaml.YAMLError as yaml_err:
            log('warning', f"YAML parse error: {yaml_err}")
            return jsonify({
                'valid': False,
                'errors': [{
                    'path': '/',
                    'message': f'YAML parse error: {str(yaml_err)}',
                    'type': 'yaml_parse'
                }]
            })
        
        if not config_dict:
            # Empty configuration is valid - user hasn't added anything yet
            return jsonify({
                'valid': True,
                'errors': []
            })
        
        # Check if this is an essentially empty/minimal config (work in progress)
        # Don't show errors for configs that are just starting to be built
        is_minimal = (
            not config_dict.get('agents') and 
            not config_dict.get('app') and 
            not config_dict.get('tools')
        )
        
        if is_minimal:
            # Config is still being built - don't show validation errors
            return jsonify({
                'valid': True,
                'errors': [],
                'status': 'incomplete'
            })
        
        # Try to import AppConfig and jsonschema
        try:
            from dao_ai.config import AppConfig
            import jsonschema
            from jsonschema import Draft7Validator, ValidationError as JsonSchemaValidationError
        except ImportError as ie:
            log('error', f"Failed to import validation libraries: {ie}")
            # If we can't import the validation library, just return valid
            # The actual deployment will catch any real errors
            return jsonify({
                'valid': True,
                'errors': [],
                'status': 'skipped',
                'message': 'Schema validation skipped - validator not available'
            })
        
        # Generate JSON schema from Pydantic model
        # This gives us the schema without triggering any model validators
        try:
            json_schema = AppConfig.model_json_schema()
            log('debug', f"Generated JSON schema with {len(json_schema.get('$defs', {}))} definitions")
        except Exception as schema_err:
            log('error', f"Failed to generate JSON schema: {schema_err}")
            return jsonify({
                'valid': True,
                'errors': [],
                'status': 'skipped',
                'message': f'Schema generation failed: {str(schema_err)}'
            })
        
        # Validate config against JSON schema
        try:
            # Create validator with format checking
            validator = Draft7Validator(json_schema)
            
            # Collect all validation errors
            errors = []
            for error in validator.iter_errors(config_dict):
                # Build path from error path
                path_parts = list(error.absolute_path)
                path = '/' + '/'.join(str(p) for p in path_parts) if path_parts else '/'
                
                errors.append({
                    'path': path,
                    'message': error.message,
                    'type': error.validator,
                    'schema_path': '/'.join(str(p) for p in error.schema_path)
                })
            
            if errors:
                log('info', f"JSON schema validation found {len(errors)} errors")
                return jsonify({
                    'valid': False,
                    'errors': errors
                })
            
            return jsonify({
                'valid': True,
                'errors': []
            })
            
        except Exception as validation_err:
            import traceback
            log('error', f"JSON schema validation error: {validation_err}")
            log('error', f"Traceback: {traceback.format_exc()}")
            return jsonify({
                'valid': False,
                'errors': [{
                    'path': '/',
                    'message': f'Validation error: {str(validation_err)}',
                    'type': 'validation_error'
                }]
            })
        
    except Exception as e:
        import traceback
        log('error', f"Error validating schema: {e}")
        log('error', f"Traceback: {traceback.format_exc()}")
        # Return 200 with error details so frontend can display them
        # instead of a 500 which looks like a server crash
        return jsonify({
            'valid': False,
            'errors': [{
                'path': '/',
                'message': f'Validation error: {str(e)}',
                'type': 'internal_error'
            }]
        })


@app.route('/api/deploy/quick', methods=['POST'])
def deploy_quick():
    """Deploy model and endpoint only (quick deployment).
    
    This uses dao_ai's create_agent() and deploy_agent() methods.
    
    Request body:
    - config: The YAML configuration as a dictionary
    - credentials: Optional credential configuration
        - type: 'app' | 'obo' | 'manual_sp' | 'manual_pat'
        - client_id: Required for manual_sp
        - client_secret: Required for manual_sp
        - pat: Required for manual_pat
    
    Returns deployment job ID and status.
    """
    try:
        import yaml
        import tempfile
        import os as os_module
        import threading
        import uuid
        from datetime import datetime
        
        data = request.get_json()
        config = data.get('config')
        credentials = data.get('credentials', {})
        target_str = data.get('target', 'model_serving')  # Default to model_serving
        skip_model_creation = data.get('skip_model_creation', False)  # Default to not skipping
        
        if not config:
            return jsonify({'error': 'config is required'}), 400
        
        # Validate target
        valid_targets = ['model_serving', 'apps']
        if target_str not in valid_targets:
            return jsonify({'error': f"Invalid target '{target_str}'. Must be one of: {valid_targets}"}), 400
        
        # Generate a unique deployment ID
        deployment_id = str(uuid.uuid4())[:8]
        
        # Get host
        host, host_source = get_databricks_host_with_source()
        
        # Determine credentials based on credential type
        cred_type = credentials.get('type', 'obo')  # Default to OBO
        token = None
        client_id = None
        client_secret = None
        
        log('info', f"Deployment credential type: {cred_type}")
        
        if cred_type == 'manual_pat':
            # Use manually provided PAT
            token = credentials.get('pat')
            if not token:
                return jsonify({'error': 'PAT is required for manual_pat credential type'}), 400
            log('info', "Using manually provided PAT for deployment")
            
        elif cred_type == 'manual_sp':
            # Use manually provided service principal
            client_id = credentials.get('client_id')
            client_secret = credentials.get('client_secret')
            if not client_id or not client_secret:
                return jsonify({'error': 'client_id and client_secret are required for manual_sp credential type'}), 400
            log('info', "Using manually provided service principal for deployment")
            
        elif cred_type == 'app':
            # Use application service principal from environment
            client_id = os.environ.get('DATABRICKS_CLIENT_ID')
            client_secret = os.environ.get('DATABRICKS_CLIENT_SECRET')
            if not client_id or not client_secret:
                return jsonify({'error': 'Application service principal not configured'}), 400
            log('info', "Using application service principal for deployment")
            
        else:  # 'obo' or default
            # Use OBO token or fall back to available token
            token, token_source = get_databricks_token_with_source()
            if not token:
                # Fall back to service principal if no token available
                client_id = os.environ.get('DATABRICKS_CLIENT_ID')
                client_secret = os.environ.get('DATABRICKS_CLIENT_SECRET')
                if not client_id or not client_secret:
                    return jsonify({
                        'error': 'No credentials available',
                        'message': 'No OBO token available and no service principal configured'
                    }), 400
                log('info', "No OBO token available, falling back to service principal")
            else:
                log('info', f"Using OBO/user token (source: {token_source}) for deployment")
        
        # Validate we have some form of authentication
        use_service_principal = client_id is not None and client_secret is not None
        if not token and not use_service_principal:
            return jsonify({
                'error': 'No authentication available',
                'message': 'Please configure DATABRICKS_CLIENT_ID and DATABRICKS_CLIENT_SECRET environment variables for deployment. OAuth tokens have limited scopes and cannot deploy models.'
            }), 401
        
        if not host:
            return jsonify({
                'error': 'No Databricks workspace URL configured',
                'message': 'Please configure DATABRICKS_WORKSPACE_URL environment variable with your workspace URL '
                          '(e.g., https://your-workspace.cloud.databricks.com). '
                          'On AWS, DATABRICKS_HOST may be set to the app URL which cannot be used for API calls.'
            }), 400
        
        # Initialize status
        _deployment_status[deployment_id] = {
            'id': deployment_id,
            'status': 'starting',
            'type': 'quick',
            'started_at': datetime.now().isoformat(),
            'steps': [
                {'name': 'validate', 'status': 'pending'},
                {'name': 'create_agent', 'status': 'pending'},
                {'name': 'deploy_agent', 'status': 'pending'},
            ],
            'current_step': 0,
            'error': None,
            'result': None
        }
        
        def run_deployment(deployment_id: str, config: dict, auth_token: str | None, 
                          auth_host: str, sp_client_id: str | None, sp_client_secret: str | None,
                          deployment_target: str = 'model_serving',
                          skip_model_creation: bool = False):
            """Run deployment in background thread."""
            try:
                status = _deployment_status[deployment_id]
                
                # Step 1: Validate and load config
                status['steps'][0]['status'] = 'running'
                status['current_step'] = 0
                
                # Write config to temp file
                with tempfile.NamedTemporaryFile(mode='w', suffix='.yaml', delete=False) as f:
                    yaml.dump(config, f)
                    config_path = f.name
                
                # Save original env vars to restore later
                orig_env = {
                    'DATABRICKS_HOST': os_module.environ.get('DATABRICKS_HOST'),
                    'DATABRICKS_TOKEN': os_module.environ.get('DATABRICKS_TOKEN'),
                    'DATABRICKS_CLIENT_ID': os_module.environ.get('DATABRICKS_CLIENT_ID'),
                    'DATABRICKS_CLIENT_SECRET': os_module.environ.get('DATABRICKS_CLIENT_SECRET'),
                    'MLFLOW_TRACKING_TOKEN': os_module.environ.get('MLFLOW_TRACKING_TOKEN'),
                }
                
                try:
                    # Import dao_ai, databricks SDK, and mlflow
                    from dao_ai.config import AppConfig
                    import mlflow
                    
                    # Load config first to access environment_vars
                    app_config = AppConfig.from_file(config_path)
                    
                    # Set environment variables for VectorSearchClient and other SDK clients
                    # These are needed because when MLflow validates the model by loading agent_as_code.py,
                    # it creates VectorSearchClient which reads from environment variables
                    log('info', f"Setting up environment for {'PAT token' if auth_token else 'service principal'} auth")
                    
                    # Clear any conflicting auth methods first
                    for var in ['DATABRICKS_TOKEN', 'DATABRICKS_CLIENT_ID', 'DATABRICKS_CLIENT_SECRET', 'MLFLOW_TRACKING_TOKEN']:
                        if var in os_module.environ:
                            del os_module.environ[var]
                    
                    # Set the host (ensure https:// scheme)
                    os_module.environ['DATABRICKS_HOST'] = normalize_host(auth_host)
                    
                    # Set the authentication method
                    if auth_token:
                        os_module.environ['DATABRICKS_TOKEN'] = auth_token
                        # Also set MLFLOW_TRACKING_TOKEN for MLflow to use
                        os_module.environ['MLFLOW_TRACKING_TOKEN'] = auth_token
                        log('info', "Using PAT token authentication")
                    elif sp_client_id and sp_client_secret:
                        os_module.environ['DATABRICKS_CLIENT_ID'] = sp_client_id
                        os_module.environ['DATABRICKS_CLIENT_SECRET'] = sp_client_secret
                        log('info', "Using service principal authentication")
                    
                    # Set MLflow tracking URI to Databricks
                    # MLflow will use DATABRICKS_HOST and DATABRICKS_TOKEN env vars for authentication
                    mlflow.set_tracking_uri("databricks")
                    mlflow.set_registry_uri("databricks-uc")
                    log('info', f"Set MLflow tracking URI to 'databricks' with host: {auth_host}")
                    
                    # Set any environment_vars from the config
                    # SKIP variables that use {{secrets/...}} syntax - these are only resolved
                    # by Databricks Model Serving at runtime, not during local agent creation.
                    # Setting them would override the fallback mechanism in database configs.
                    if app_config.app and app_config.app.environment_vars:
                        log('info', f"Processing {len(app_config.app.environment_vars)} environment variables from config")
                        for key, value in app_config.app.environment_vars.items():
                            if value is not None:
                                str_value = str(value)
                                # Skip Model Serving secret references - they only work at runtime
                                if '{{secrets/' in str_value:
                                    log('info', f"Skipping {key} - contains Model Serving secret reference (will be resolved at runtime)")
                                    continue
                                # Save original value for restoration
                                if key not in orig_env:
                                    orig_env[key] = os_module.environ.get(key)
                                os_module.environ[key] = str_value
                                log('info', f"Set environment variable: {key}")
                    
                    status['steps'][0]['status'] = 'completed'
                    
                    # Step 2: Create agent (or skip if requested for Apps deployment)
                    # Pass credentials directly to create_agent - the updated dao_ai library
                    # now supports passing pat/client_id/client_secret/workspace_host directly
                    # Use lock to atomically check cancelled flag and update status
                    with _deployment_status_lock:
                        if status.get('cancelled'):
                            log('info', f"Deployment {deployment_id} cancelled before agent creation")
                            # Status already set to 'cancelled' by cancel endpoint
                            return
                        
                        # Check if we should skip model creation (only allowed for Apps deployment)
                        if skip_model_creation and deployment_target == 'apps':
                            log('info', f"Skipping model creation for Apps deployment (skip_model_creation=True)")
                            status['steps'][1]['status'] = 'skipped'
                            status['current_step'] = 1
                            status['status'] = 'skipping_model_creation'
                        else:
                            status['steps'][1]['status'] = 'running'
                            status['current_step'] = 1
                            status['status'] = 'creating_agent'
                    
                    # Only run model creation if not skipped
                    if not (skip_model_creation and deployment_target == 'apps'):
                        # Monkey-patch DatabricksFunctionClient to skip Spark session initialization
                        # This is needed because the function client tries to create a Spark session
                        # via Databricks Connect, which requires OAuth scopes that deployment tokens
                        # typically don't have (Invalid scope error)
                        original_set_spark = None
                        try:
                            from unitycatalog.ai.core.databricks import DatabricksFunctionClient
                            original_set_spark = DatabricksFunctionClient.set_spark_session
                            def skip_spark_session(self):
                                log('info', "Skipping Spark session initialization for deployment")
                                self.spark = None
                            DatabricksFunctionClient.set_spark_session = skip_spark_session
                            log('info', "Patched DatabricksFunctionClient to skip Spark session")
                        except ImportError:
                            log('warning', "Could not patch DatabricksFunctionClient - unitycatalog not found")
                        
                        log('info', f"Creating agent with {'PAT token' if auth_token else 'service principal'} auth for host: {auth_host}")
                        try:
                            app_config.create_agent(
                                pat=auth_token,
                                client_id=sp_client_id,
                                client_secret=sp_client_secret,
                                workspace_host=auth_host,
                            )
                        finally:
                            # Restore original method
                            if original_set_spark:
                                DatabricksFunctionClient.set_spark_session = original_set_spark
                                log('info', "Restored DatabricksFunctionClient.set_spark_session")
                    # Step 3: Deploy agent
                    # Use lock to atomically check cancelled flag and update status
                    with _deployment_status_lock:
                        if status.get('cancelled'):
                            log('info', f"Deployment {deployment_id} cancelled before deployment")
                            # Status already set to 'cancelled' by cancel endpoint
                            return
                        # Mark step 1 as completed (if not skipped) and start step 2
                        if status['steps'][1]['status'] != 'skipped':
                            status['steps'][1]['status'] = 'completed'
                        status['steps'][2]['status'] = 'running'
                        status['current_step'] = 2
                        status['status'] = 'deploying'
                    
                    # Import DeploymentTarget enum
                    from dao_ai.config import DeploymentTarget
                    target = DeploymentTarget(deployment_target)
                    
                    log('info', f"Deploying agent with {'PAT token' if auth_token else 'service principal'} auth for host: {auth_host}, target: {deployment_target}")
                    app_config.deploy_agent(
                        target=target,
                        pat=auth_token,
                        client_id=sp_client_id,
                        client_secret=sp_client_secret,
                        workspace_host=auth_host,
                    )
                    # Check for cancellation - even if step completed, respect cancellation request
                    # Use lock to ensure consistent state
                    with _deployment_status_lock:
                        if status.get('cancelled'):
                            log('info', f"Deployment {deployment_id} cancelled during/after deployment")
                            # Status already set to 'cancelled' by cancel endpoint
                            return
                        
                        status['steps'][2]['status'] = 'completed'
                        status['status'] = 'completed'
                        status['completed_at'] = datetime.now().isoformat()
                        status['result'] = {
                            'endpoint_name': app_config.app.endpoint_name,
                            'model_name': app_config.app.registered_model.full_name,
                            'message': 'Deployment completed successfully'
                        }
                    
                finally:
                    # Restore original env vars
                    for var, value in orig_env.items():
                        if value is not None:
                            os_module.environ[var] = value
                        elif var in os_module.environ:
                            del os_module.environ[var]
                    
                    # Cleanup temp file
                    os_module.unlink(config_path)
                    
            except Exception as e:
                import traceback
                error_msg = str(e)
                error_trace = traceback.format_exc()
                log('error', f"Deployment {deployment_id} failed: {error_msg}")
                log('error', f"Traceback: {error_trace}")
                
                status = _deployment_status.get(deployment_id, {})
                status['status'] = 'failed'
                status['error'] = error_msg
                status['error_trace'] = error_trace
                status['completed_at'] = datetime.now().isoformat()
                
                # Mark current step as failed
                if 'steps' in status and 'current_step' in status:
                    current = status['current_step']
                    if current < len(status['steps']):
                        status['steps'][current]['status'] = 'failed'
                        status['steps'][current]['error'] = error_msg
        
        # Start deployment in background with auth credentials
        thread = threading.Thread(
            target=run_deployment, 
            args=(deployment_id, config, token, host, client_id, client_secret, target_str, skip_model_creation)
        )
        thread.daemon = True
        thread.start()
        
        return jsonify({
            'deployment_id': deployment_id,
            'status': 'started',
            'message': 'Quick deployment started. Use /api/deploy/status/{id} to check progress.',
            'status_url': f'/api/deploy/status/{deployment_id}'
        })
        
    except Exception as e:
        import traceback
        log('error', f"Error starting deployment: {e}")
        log('error', f"Traceback: {traceback.format_exc()}")
        return jsonify({'error': str(e)}), 500


@app.route('/api/deploy/status/<deployment_id>')
def get_deployment_status(deployment_id: str):
    """Get deployment status.
    
    Returns the current status of a deployment job.
    Uses a lock to ensure we get a consistent snapshot of the status.
    """
    status = _deployment_status.get(deployment_id)
    
    if not status:
        return jsonify({'error': 'Deployment not found'}), 404
    
    # Take a snapshot under lock to avoid reading partially updated status
    with _deployment_status_lock:
        status_copy = dict(status)
        # Deep copy steps to avoid issues with nested list
        if 'steps' in status_copy:
            status_copy['steps'] = [dict(step) for step in status_copy['steps']]
    
    return jsonify(status_copy)


@app.route('/api/deploy/list')
def list_deployments():
    """List all deployment jobs.
    
    Returns a list of all deployment jobs with their status.
    """
    # Return deployments sorted by start time (newest first)
    deployments = list(_deployment_status.values())
    deployments.sort(key=lambda x: x.get('started_at', ''), reverse=True)
    
    return jsonify({
        'deployments': deployments,
        'count': len(deployments)
    })


@app.route('/api/deploy/cancel/<deployment_id>', methods=['POST'])
def cancel_deployment(deployment_id: str):
    """Cancel a running deployment.
    
    This sets a cancel flag that the deployment thread will check.
    Uses a lock to prevent race conditions with the deployment thread.
    """
    log('info', f"Cancel request received for deployment {deployment_id}")
    
    status = _deployment_status.get(deployment_id)
    
    if not status:
        log('warning', f"Cancel failed: deployment {deployment_id} not found")
        return jsonify({'error': 'Deployment not found'}), 404
    
    # Use lock to prevent race condition with deployment thread
    with _deployment_status_lock:
        # Re-check status under lock
        current_status = status['status']
        log('info', f"Current status before cancel: {current_status}")
        
        # Only cancel if deployment is in progress
        if current_status not in ['starting', 'creating_agent', 'deploying']:
            log('warning', f"Cancel failed: deployment is {current_status}")
            return jsonify({
                'error': 'Deployment cannot be cancelled',
                'message': f"Deployment is {current_status}"
            }), 400
        
        # Set cancelled flag atomically with status update
        status['cancelled'] = True
        status['status'] = 'cancelled'
        status['completed_at'] = datetime.now().isoformat()
        
        # Mark current step as failed with cancellation message
        if 'steps' in status and 'current_step' in status:
            current = status['current_step']
            if current < len(status['steps']):
                status['steps'][current]['status'] = 'failed'
                status['steps'][current]['error'] = 'Cancelled by user'
        
        # Return a copy of status to avoid concurrent modification during serialization
        status_copy = dict(status)
    
    log('info', f"Deployment {deployment_id} cancelled successfully. Status is now: {status_copy['status']}")
    
    return jsonify({
        'message': 'Deployment cancelled',
        'deployment_id': deployment_id,
        'status': status_copy  # Include full status in response for immediate frontend update
    })


# =============================================================================
# Local Chat with Agent
# =============================================================================

@app.route('/api/chat', methods=['POST'])
def chat_with_agent():
    """Chat locally with the configured agent using streaming.
    
    This endpoint creates a ResponsesAgent from the current configuration
    and streams chat responses using Server-Sent Events (SSE).
    
    Request body:
    - config: The full AppConfig configuration
    - messages: List of chat messages [{"role": "user/assistant", "content": "..."}]
    - context: Optional context variables (thread_id, user_id, etc.)
    
    Returns:
    - SSE stream with events: log, delta, done, error
    """
    import json as json_module
    
    data = request.get_json()
    config_dict = data.get('config')
    messages = data.get('messages', [])
    context = data.get('context', {})
    credentials = data.get('credentials', {})
    
    # Capture auth info BEFORE entering the generator (while still in request context)
    # Priority: manual credentials > OBO token > SDK config
    auth_token = None
    auth_token_source = None
    auth_client_id = None
    auth_client_secret = None
    
    cred_type = credentials.get('type', 'obo')
    
    if cred_type == 'manual_pat' and credentials.get('pat'):
        auth_token = credentials['pat']
        auth_token_source = 'manual_pat'
    elif cred_type == 'manual_sp' and credentials.get('client_id') and credentials.get('client_secret'):
        auth_client_id = credentials['client_id']
        auth_client_secret = credentials['client_secret']
        auth_token_source = 'manual_sp'
    else:
        # Fall back to OBO or other auth methods
        auth_token, auth_token_source = get_databricks_token_with_source()
    
    auth_host, auth_host_source = get_databricks_host_with_source()
    
    def generate():
        """Generator for SSE stream"""
        
        def send_log(level: str, message: str):
            """Send a log event"""
            log(level, message)  # Also log to server
            yield f"data: {json_module.dumps({'type': 'log', 'level': level, 'message': message})}\n\n"
        
        def send_delta(content: str):
            """Send a text delta event"""
            yield f"data: {json_module.dumps({'type': 'delta', 'content': content})}\n\n"
        
        def send_done(full_response: str):
            """Send completion event"""
            yield f"data: {json_module.dumps({'type': 'done', 'response': full_response})}\n\n"
        
        def send_error(error: str, trace: str = None):
            """Send error event"""
            data = {'type': 'error', 'error': error}
            if trace:
                data['trace'] = trace
            yield f"data: {json_module.dumps(data)}\n\n"
        
        try:
            if not config_dict:
                yield from send_error('Configuration is required')
                return
            
            if not messages:
                yield from send_error('Messages are required')
                return
            
            yield from send_log('info', f"Chat request received with {len(messages)} messages")
            
            # Set up authentication - use captured auth info from request context
            # IMPORTANT: Clear ALL auth env vars first to avoid conflicts
            for var in ['DATABRICKS_TOKEN', 'DATABRICKS_CLIENT_ID', 'DATABRICKS_CLIENT_SECRET', 'MLFLOW_TRACKING_TOKEN']:
                if var in os.environ:
                    del os.environ[var]
            
            if auth_token_source == 'manual_sp':
                yield from send_log('info', 'Using manual service principal authentication')
                os.environ['DATABRICKS_CLIENT_ID'] = auth_client_id
                os.environ['DATABRICKS_CLIENT_SECRET'] = auth_client_secret
            elif auth_token:
                yield from send_log('info', f"Using {auth_token_source} authentication")
                os.environ['DATABRICKS_TOKEN'] = auth_token
                os.environ['MLFLOW_TRACKING_TOKEN'] = auth_token
            else:
                yield from send_log('warning', 'No authentication token available - some features may not work')
            
            if auth_host:
                yield from send_log('debug', f"Using Databricks host from {auth_host_source}: {auth_host[:30]}...")
                os.environ['DATABRICKS_HOST'] = normalize_host(auth_host)
            
            # Import dao-ai components
            try:
                from dao_ai.config import AppConfig
                from mlflow.pyfunc import ResponsesAgent
                yield from send_log('debug', 'Imported dao-ai and mlflow components')
            except ImportError as e:
                yield from send_error(f'dao-ai library not available: {e}')
                return
            
            # Create AppConfig from the configuration
            try:
                app_config = AppConfig(**config_dict)
                yield from send_log('info', f"Created AppConfig for app: {app_config.app.name}")
                
                # Log agent details
                agent_names = list(config_dict.get('agents', {}).keys())
                yield from send_log('debug', f"Agents: {', '.join(agent_names)}")
                
                # Log orchestration type
                orch = config_dict.get('app', {}).get('orchestration', {})
                if orch.get('supervisor'):
                    yield from send_log('debug', f"Orchestration: Supervisor ({orch['supervisor'].get('name', 'unnamed')})")
                elif orch.get('swarm'):
                    yield from send_log('debug', f"Orchestration: Swarm ({orch['swarm'].get('name', 'unnamed')})")
            except Exception as e:
                import traceback
                yield from send_error(f'Invalid configuration: {str(e)}', traceback.format_exc())
                return
            
            # Create the ResponsesAgent
            try:
                yield from send_log('info', 'Creating LangGraph from configuration...')
                agent: ResponsesAgent = app_config.as_responses_agent()
                yield from send_log('info', "Created ResponsesAgent successfully")
            except Exception as e:
                import traceback
                yield from send_error(f'Failed to create agent: {str(e)}', traceback.format_exc())
                return
            
            # Build the request for the ResponsesAgent
            from mlflow.types.responses import ResponsesAgentRequest
            
            yield from send_log('debug', 'Building ResponsesAgentRequest...')
            
            # Build input items from messages
            input_items = []
            for msg in messages:
                role = msg.get('role', 'user')
                content = msg.get('content', '')
                
                if role == 'user':
                    input_items.append({
                        'type': 'message',
                        'role': 'user',
                        'content': [{'type': 'input_text', 'text': content}]
                    })
                elif role == 'assistant':
                    input_items.append({
                        'type': 'message',
                        'role': 'assistant',
                        'content': [{'type': 'output_text', 'text': content}]
                    })
            
            # Build context/custom data
            custom_data = {}
            if context:
                custom_data['configurable'] = context
                yield from send_log('debug', f"Context: thread_id={context.get('thread_id', 'none')}, user_id={context.get('user_id', 'none')}")
            
            # Add any custom_inputs from the request
            custom_inputs_from_request = data.get('custom_inputs', {})
            if custom_inputs_from_request:
                custom_data.update(custom_inputs_from_request)
                yield from send_log('debug', f"Custom inputs: {list(custom_inputs_from_request.keys())}")
            
            # Create the request
            agent_request = ResponsesAgentRequest(
                input=input_items,
                custom_inputs=custom_data if custom_data else None
            )
            
            # Stream the response
            try:
                yield from send_log('info', "Starting streaming response...")
                
                full_response = ""
                
                # Check if agent has predict_stream method
                custom_outputs = None
                if hasattr(agent, 'predict_stream'):
                    yield from send_log('debug', "Using streaming mode")
                    
                    for event in agent.predict_stream(agent_request):
                        # Extract delta content from the event
                        if hasattr(event, 'type'):
                            if event.type == 'response.output_text.delta':
                                # Text delta event
                                delta = getattr(event, 'delta', '')
                                if delta:
                                    full_response += delta
                                    yield from send_delta(delta)
                            elif event.type == 'response.output_item.done':
                                # Item complete - extract full text if available
                                if hasattr(event, 'item') and hasattr(event.item, 'content'):
                                    for content_item in event.item.content:
                                        if hasattr(content_item, 'text'):
                                            # Use full text if we didn't get deltas
                                            if not full_response:
                                                full_response = content_item.text
                                # Extract custom_outputs if available
                                yield from send_log('debug', f"Checking for custom_outputs on event: hasattr={hasattr(event, 'custom_outputs')}")
                                if hasattr(event, 'custom_outputs'):
                                    yield from send_log('debug', f"custom_outputs value: {event.custom_outputs}")
                                    if event.custom_outputs:
                                        custom_outputs = event.custom_outputs
                                        yield from send_log('debug', f"Captured custom_outputs")
                else:
                    # Fallback to non-streaming mode
                    yield from send_log('warning', "Streaming not available, using standard mode")
                    
                    response = agent.predict(agent_request)
                    
                    if response and response.output:
                        for item in response.output:
                            if hasattr(item, 'content'):
                                for content_item in item.content:
                                    if hasattr(content_item, 'text'):
                                        full_response += content_item.text
                                        yield from send_delta(content_item.text)
                                    elif isinstance(content_item, dict) and 'text' in content_item:
                                        full_response += content_item['text']
                                        yield from send_delta(content_item['text'])
                            elif hasattr(item, 'text'):
                                full_response += item.text
                                yield from send_delta(item.text)
                    
                    # Extract custom_outputs from non-streaming response
                    if hasattr(response, 'custom_outputs') and response.custom_outputs:
                        custom_outputs = response.custom_outputs
                
                if not full_response:
                    yield from send_log('warning', "No response text extracted")
                    full_response = "No response generated"
                else:
                    yield from send_log('info', f"Completed: {len(full_response)} characters")
                
                # Include custom_outputs in done event if available
                if custom_outputs:
                    yield from send_log('debug', f"Raw custom_outputs type: {type(custom_outputs).__name__}")
                    yield from send_log('debug', f"Raw custom_outputs keys: {list(custom_outputs.keys()) if hasattr(custom_outputs, 'keys') else 'N/A'}")
                    
                    # Convert to dict if it's a Pydantic model or similar
                    if hasattr(custom_outputs, 'model_dump'):
                        custom_outputs = custom_outputs.model_dump()
                    elif hasattr(custom_outputs, 'dict'):
                        custom_outputs = custom_outputs.dict()
                    elif not isinstance(custom_outputs, dict):
                        custom_outputs = dict(custom_outputs)
                    
                    # Filter out configurable from custom_outputs for display
                    display_outputs = {k: v for k, v in custom_outputs.items() if k != 'configurable'}
                    
                    if display_outputs:
                        yield from send_log('info', f"Custom outputs received: {list(display_outputs.keys())}")
                        try:
                            yield f"data: {json.dumps({'type': 'custom_outputs', 'data': display_outputs})}\n\n"
                        except (TypeError, ValueError) as e:
                            yield from send_log('warning', f"Could not serialize custom_outputs: {str(e)}")
                    else:
                        yield from send_log('debug', "No display outputs after filtering configurable")
                
                yield from send_done(full_response)
                
            except Exception as e:
                import traceback
                yield from send_error(f'Agent invocation failed: {str(e)}', traceback.format_exc())
                return
                
        except Exception as e:
            import traceback
            yield from send_error(str(e), traceback.format_exc())
    
    return Response(generate(), mimetype='text/event-stream', headers={
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no'
    })


# =============================================================================
# Static File Serving
# =============================================================================

@app.route('/')
def index():
    """Serve the React frontend."""
    return send_from_directory(STATIC_FOLDER, 'index.html')


@app.route('/<path:path>')
def serve_static(path: str):
    """Serve static files or fall back to index.html for SPA routing."""
    if path.startswith('api/'):
        return jsonify({'error': 'Not found'}), 404
    
    file_path = os.path.join(STATIC_FOLDER, path)
    if os.path.isfile(file_path):
        return send_from_directory(STATIC_FOLDER, path)
    
    # SPA fallback - serve index.html for client-side routing
    return send_from_directory(STATIC_FOLDER, 'index.html')


# =============================================================================
# Version Info
# =============================================================================

@app.route('/api/version')
def get_version():
    """Get the dao-ai library version."""
    # First check for DAO_AI_VERSION environment variable (set in app.yaml)
    dao_ai_version = os.environ.get('DAO_AI_VERSION')
    
    # If not set, try to get from installed package
    if not dao_ai_version:
        try:
            import importlib.metadata
            # Try both package name formats
            try:
                dao_ai_version = importlib.metadata.version('dao-ai')
            except importlib.metadata.PackageNotFoundError:
                try:
                    dao_ai_version = importlib.metadata.version('dao_ai')
                except importlib.metadata.PackageNotFoundError:
                    pass
        except Exception as e:
            log('warning', f"Could not get dao-ai version: {e}")
    
    if not dao_ai_version:
        dao_ai_version = 'unknown'
    
    return jsonify({
        'dao_ai': dao_ai_version,
        'app': 'dao-ai-builder',
    })


@app.route('/api/github-config')
def get_github_config():
    """Get GitHub repository configuration for config templates."""
    return jsonify({
        'repo': os.environ.get('GITHUB_CONFIG_REPO', 'natefleming/dao-ai'),
        'branch': os.environ.get('GITHUB_CONFIG_BRANCH', 'main'),
        'path': os.environ.get('GITHUB_CONFIG_PATH', 'config'),
    })


# =============================================================================
# AI Prompt Assistant
# =============================================================================

@app.route('/api/ai/generate-prompt', methods=['POST'])
def generate_prompt():
    """Generate an optimized prompt using Claude for GenAI agent applications.
    
    Request body:
    - context: Description of what the agent should do
    - agent_name: Name of the agent (optional)
    - agent_description: Description of the agent (optional)
    - tools: List of tools available to the agent (optional)
    - existing_prompt: Existing prompt to improve (optional)
    - template_parameters: List of template variables to include (optional)
    
    Returns:
    - prompt: Generated optimized prompt
    """
    try:
        data = request.get_json()
        context = data.get('context', '')
        agent_name = data.get('agent_name', '')
        agent_description = data.get('agent_description', '')
        tools = data.get('tools', [])
        existing_prompt = data.get('existing_prompt', '')
        template_parameters = data.get('template_parameters', [])
        
        if not context and not existing_prompt:
            return jsonify({'error': 'Either context or existing_prompt is required'}), 400
        
        # Use the app's service principal credentials for the serving endpoint
        # The serving endpoint is configured as an app resource with CAN_QUERY permission
        log('info', "Generating prompt using Claude with app service principal")
        
        # Build template parameters instruction
        template_params_instruction = ""
        if template_parameters:
            params_formatted = ", ".join([f"{{{p}}}" for p in template_parameters])
            template_params_instruction = f"\n7. IMPORTANT: Include these template variables in a User Information section at the start of the prompt: {params_formatted}"
        else:
            template_params_instruction = "\n7. Use template variables like {user_id}, {store_num}, {context} for dynamic information"
        
        # Build the system message for prompt generation
        system_message = f"""You are an expert prompt engineer specializing in creating highly effective system prompts for AI agents. Your task is to generate optimized prompts for GenAI agent applications that follow best practices.

When creating prompts, follow these guidelines:
1. Be specific and clear about the agent's role and responsibilities
2. Include relevant context about the domain and use case
3. Define the agent's capabilities and limitations
4. Provide clear instructions for tool usage when tools are available
5. Include guidelines for response format and tone
6. Add safety and guardrail instructions where appropriate{template_params_instruction}
8. Structure the prompt with clear sections (role, capabilities, guidelines, etc.)
9. Make the prompt concise but comprehensive
10. Focus on actionable instructions rather than vague guidance

Output ONLY the prompt text, without any additional explanation or markdown formatting."""

        # Build the user message
        user_parts = []
        
        if existing_prompt:
            user_parts.append(f"Please improve and optimize this existing prompt:\n\n{existing_prompt}")
        else:
            user_parts.append(f"Please create an optimized system prompt for the following agent:")
        
        if agent_name:
            user_parts.append(f"\nAgent Name: {agent_name}")
        
        if agent_description:
            user_parts.append(f"\nAgent Description: {agent_description}")
        
        if context:
            user_parts.append(f"\nContext/Requirements: {context}")
        
        if tools:
            tools_str = ", ".join(tools) if isinstance(tools, list) else str(tools)
            user_parts.append(f"\nAvailable Tools: {tools_str}")
            user_parts.append("\nInclude clear instructions for when and how to use these tools.")
        
        if template_parameters:
            params_list = ", ".join([f"{{{p}}}" for p in template_parameters])
            user_parts.append(f"\nTemplate Parameters to include: {params_list}")
            user_parts.append("Include a '### User Information' section at the beginning that displays these parameters.")
        
        user_message = "\n".join(user_parts)
        
        # Call the Databricks serving endpoint using the SDK
        # This uses the app's service principal credentials automatically
        try:
            from databricks.sdk.service.serving import ChatMessage, ChatMessageRole
            
            w = get_workspace_client()
            
            messages = [
                ChatMessage(role=ChatMessageRole.SYSTEM, content=system_message),
                ChatMessage(role=ChatMessageRole.USER, content=user_message)
            ]
            
            log('info', "Calling Claude endpoint via SDK serving_endpoints.query()")
            
            response = w.serving_endpoints.query(
                name="databricks-claude-sonnet-4",
                messages=messages,
                max_tokens=2000,
                temperature=0.7
            )
            
            # Extract the generated prompt from the response
            generated_prompt = ''
            if response.choices and len(response.choices) > 0:
                generated_prompt = response.choices[0].message.content
            
            if not generated_prompt:
                log('error', f"No content in response: {response}")
                return jsonify({'error': 'No response generated'}), 500
            
            log('info', f"Successfully generated prompt ({len(generated_prompt)} chars)")
            return jsonify({'prompt': generated_prompt.strip()})
            
        except Exception as sdk_error:
            log('error', f"SDK serving endpoint query failed: {sdk_error}")
            return jsonify({'error': f'Failed to generate prompt: {str(sdk_error)}'}), 500
            
    except Exception as e:
        import traceback
        log('error', f"Error generating prompt: {e}")
        log('error', f"Traceback: {traceback.format_exc()}")
        return jsonify({'error': str(e)}), 500


@app.route('/api/ai/generate-guardrail-prompt', methods=['POST'])
def generate_guardrail_prompt():
    """Generate an optimized guardrail evaluation prompt using Claude.
    
    Request body:
    - context: Description of what the guardrail should evaluate
    - guardrail_name: Name of the guardrail (optional)
    - evaluation_criteria: List of criteria to evaluate (optional)
    - existing_prompt: Existing prompt to improve (optional)
    
    Returns:
    - prompt: Generated optimized guardrail prompt
    """
    try:
        data = request.get_json()
        context = data.get('context', '')
        guardrail_name = data.get('guardrail_name', '')
        evaluation_criteria = data.get('evaluation_criteria', [])
        existing_prompt = data.get('existing_prompt', '')
        
        if not context and not existing_prompt and not evaluation_criteria:
            return jsonify({'error': 'Either context, evaluation_criteria, or existing_prompt is required'}), 400
        
        # Use the app's service principal credentials for the serving endpoint
        log('info', "Generating guardrail prompt using Claude with app service principal")
        
        # Build criteria instruction
        criteria_instruction = ""
        if evaluation_criteria:
            criteria_list = "\n".join([f"- {c.replace('_', ' ').title()}" for c in evaluation_criteria])
            criteria_instruction = f"\n\nThe guardrail should specifically evaluate these criteria:\n{criteria_list}"
        
        # Build the system message for guardrail prompt generation
        system_message = f"""You are an expert prompt engineer specializing in creating guardrail evaluation prompts for AI agents. Your task is to generate optimized guardrail prompts that effectively evaluate AI responses.

When creating guardrail prompts, follow these guidelines:
1. Clearly define the role as an expert judge evaluating AI responses
2. Include specific, measurable evaluation criteria
3. Provide clear pass/fail conditions for each criterion
4. Include instructions for the judge to output structured feedback
5. Use {{inputs}} placeholder for the user's original query/conversation
6. Use {{outputs}} placeholder for the AI's response being evaluated
7. Make the evaluation criteria objective and actionable
8. Include instructions to provide constructive feedback when the response fails
9. Structure the output to include both a pass/fail decision and detailed reasoning

Output ONLY the prompt text, without any additional explanation or markdown formatting."""

        # Build the user message
        user_parts = []
        
        if existing_prompt:
            user_parts.append(f"Please improve and optimize this existing guardrail evaluation prompt:\n\n{existing_prompt}")
        else:
            user_parts.append("Please create an optimized guardrail evaluation prompt.")
        
        if guardrail_name:
            user_parts.append(f"\nGuardrail Name: {guardrail_name}")
        
        if context:
            user_parts.append(f"\nContext/Requirements: {context}")
        
        if evaluation_criteria:
            criteria_str = ", ".join([c.replace('_', ' ').title() for c in evaluation_criteria])
            user_parts.append(f"\nEvaluation Criteria to include: {criteria_str}")
            user_parts.append("\nMake sure each of these criteria has clear pass/fail conditions.")
        
        user_parts.append("\nThe prompt should use {inputs} for the conversation context and {outputs} for the AI response being evaluated.")
        
        user_message = "\n".join(user_parts)
        
        # Call the Databricks serving endpoint using the SDK
        from databricks.sdk.service.serving import ChatMessage, ChatMessageRole
        
        w = get_workspace_client()
        
        messages = [
            ChatMessage(role=ChatMessageRole.SYSTEM, content=system_message),
            ChatMessage(role=ChatMessageRole.USER, content=user_message)
        ]
        
        log('info', "Calling Claude endpoint for guardrail prompt via SDK serving_endpoints.query()")
        
        response = w.serving_endpoints.query(
            name="databricks-claude-sonnet-4",
            messages=messages,
            max_tokens=2000,
            temperature=0.7
        )
        
        # Extract the generated prompt from the response
        generated_prompt = ''
        if response.choices and len(response.choices) > 0:
            generated_prompt = response.choices[0].message.content
        
        if not generated_prompt:
            log('error', f"No content in response: {response}")
            return jsonify({'error': 'No response generated'}), 500
        
        log('info', f"Successfully generated guardrail prompt ({len(generated_prompt)} chars)")
        return jsonify({'prompt': generated_prompt.strip()})
            
    except Exception as e:
        import traceback
        log('error', f"Error generating guardrail prompt: {e}")
        log('error', f"Traceback: {traceback.format_exc()}")
        return jsonify({'error': str(e)}), 500


@app.route('/api/ai/generate-handoff-prompt', methods=['POST'])
def generate_handoff_prompt():
    """Generate an optimized handoff prompt using Claude.
    
    A handoff prompt describes when an agent should be called in a multi-agent system.
    It's used by supervisors/orchestrators to decide routing.
    
    Request body:
    - agent_name: Name of the agent
    - agent_description: Description of the agent (optional)
    - system_prompt: The agent's system prompt to base the handoff on
    - existing_handoff: Existing handoff prompt to improve (optional)
    - other_agents: List of other agent names in the system (optional)
    
    Returns:
    - prompt: Generated optimized handoff prompt
    """
    try:
        data = request.get_json() or {}
        agent_name = data.get('agent_name', '')
        agent_description = data.get('agent_description', '')
        system_prompt = data.get('system_prompt', '')
        existing_handoff = data.get('existing_handoff', '')
        other_agents = data.get('other_agents', [])
        
        if not system_prompt and not existing_handoff and not agent_description:
            return jsonify({'error': 'Either system_prompt, agent_description, or existing_handoff is required'}), 400
        
        log('info', "Generating handoff prompt using Claude with app service principal")
        
        # Build the system message for handoff prompt generation
        system_message = """You are an expert at designing multi-agent AI systems. Your task is to generate concise handoff prompts that describe when a specific agent should be called.

A handoff prompt is used by a supervisor or orchestrator agent to decide which specialized agent should handle a user's request. The handoff prompt should:

1. Be concise and action-oriented (1-3 sentences max)
2. Clearly describe the TYPE of requests or tasks this agent handles
3. Include specific keywords or topics that should trigger routing to this agent
4. Differentiate this agent's responsibilities from other agents in the system
5. Focus on WHEN to call this agent, not HOW the agent works internally

Good handoff prompts are specific and decisive:
- "Route to this agent for product searches, inventory lookups, and finding items by name, category, or SKU."
- "Call this agent when the user needs help with order status, returns, refunds, or shipping issues."
- "Use this agent for technical troubleshooting, installation help, and product compatibility questions."

Avoid vague descriptions like "handles general questions" or "helps with various tasks."

Output ONLY the handoff prompt text, without any additional explanation or formatting."""

        # Build the user message
        user_parts = []
        
        if existing_handoff:
            user_parts.append(f"Please improve this existing handoff prompt:\n\n{existing_handoff}")
        else:
            user_parts.append("Please create a handoff prompt for this agent.")
        
        if agent_name:
            user_parts.append(f"\nAgent Name: {agent_name}")
        
        if agent_description:
            user_parts.append(f"\nAgent Description: {agent_description}")
        
        if system_prompt:
            # Truncate very long system prompts
            truncated_prompt = system_prompt[:2000] + "..." if len(system_prompt) > 2000 else system_prompt
            user_parts.append(f"\nAgent's System Prompt:\n{truncated_prompt}")
        
        if other_agents:
            agents_list = ", ".join(other_agents)
            user_parts.append(f"\nOther agents in the system: {agents_list}")
            user_parts.append("\nMake sure the handoff prompt differentiates this agent from the others.")
        
        user_message = "\n".join(user_parts)
        
        # Call the Databricks serving endpoint using the SDK
        from databricks.sdk.service.serving import ChatMessage, ChatMessageRole
        
        w = get_workspace_client()
        
        messages = [
            ChatMessage(role=ChatMessageRole.SYSTEM, content=system_message),
            ChatMessage(role=ChatMessageRole.USER, content=user_message)
        ]
        
        log('info', "Calling Claude endpoint for handoff prompt via SDK serving_endpoints.query()")
        
        response = w.serving_endpoints.query(
            name="databricks-claude-sonnet-4",
            messages=messages,
            max_tokens=500,  # Handoff prompts should be concise
            temperature=0.7
        )
        
        # Extract the generated prompt from the response
        generated_prompt = ''
        if response.choices and len(response.choices) > 0:
            generated_prompt = response.choices[0].message.content
        
        if not generated_prompt:
            log('error', f"No content in response: {response}")
            return jsonify({'error': 'No response generated'}), 500
        
        log('info', f"Successfully generated handoff prompt ({len(generated_prompt)} chars)")
        return jsonify({'prompt': generated_prompt.strip()})
            
    except Exception as e:
        import traceback
        log('error', f"Error generating handoff prompt: {e}")
        log('error', f"Traceback: {traceback.format_exc()}")
        return jsonify({'error': str(e)}), 500


@app.route('/api/ai/generate-supervisor-prompt', methods=['POST'])
def generate_supervisor_prompt():
    """Generate an optimized supervisor prompt using Claude.
    
    A supervisor prompt guides the orchestrator agent in routing requests
    to the appropriate specialized agents.
    
    Request body:
    - context: Additional context or requirements for the supervisor (optional)
    - agents: List of agents with their names, descriptions, and handoff prompts (optional)
    - existing_prompt: Existing prompt to improve (optional)
    
    Returns:
    - prompt: Generated optimized supervisor prompt
    """
    try:
        data = request.get_json() or {}
        context = data.get('context', '')
        agents_data = data.get('agents', [])
        existing_prompt = data.get('existing_prompt', '')
        
        if not agents_data and not existing_prompt and not context:
            return jsonify({'error': 'At least one of agents, context, or existing_prompt is required'}), 400
        
        log('info', "Generating supervisor prompt using Claude with app service principal")
        
        # Build the system message for supervisor prompt generation
        system_message = """You are an expert at designing multi-agent AI orchestration systems. Your task is to generate an effective supervisor prompt that guides an orchestrator agent in routing user requests to specialized agents.

A supervisor prompt should:

1. Clearly define the supervisor's role as a router/orchestrator
2. List each available agent with a clear description of when to route to them
3. Include decision-making criteria for ambiguous requests
4. Define a default agent or fallback behavior
5. Include instructions for handling multi-step requests that may need multiple agents
6. Be clear about maintaining conversation context across agent handoffs
7. Include safety guidelines (don't make up information, admit when unsure)

The prompt should be structured with clear sections:
- Role Definition
- Available Agents (with routing criteria for each)
- Decision Guidelines
- Response Format Guidelines
- Safety Guidelines

Output ONLY the prompt text, without any additional explanation or markdown code fences."""

        # Build the user message with agent information
        user_parts = []
        
        if existing_prompt:
            user_parts.append(f"Please improve and optimize this existing supervisor prompt:\n\n{existing_prompt}")
        else:
            user_parts.append("Please create an optimized supervisor prompt for orchestrating the following agents:")
        
        if agents_data:
            user_parts.append("\n\n## Agents to Orchestrate:")
            for agent in agents_data:
                agent_name = agent.get('name', 'Unknown')
                agent_desc = agent.get('description', '')
                handoff_prompt = agent.get('handoff_prompt', '')
                
                user_parts.append(f"\n### {agent_name}")
                if agent_desc:
                    user_parts.append(f"Description: {agent_desc}")
                if handoff_prompt:
                    user_parts.append(f"When to route here: {handoff_prompt}")
        
        if context:
            user_parts.append(f"\n\n## Additional Requirements:\n{context}")
        
        user_message = "\n".join(user_parts)
        
        # Call the Databricks serving endpoint using the SDK
        from databricks.sdk.service.serving import ChatMessage, ChatMessageRole
        
        w = get_workspace_client()
        
        messages = [
            ChatMessage(role=ChatMessageRole.SYSTEM, content=system_message),
            ChatMessage(role=ChatMessageRole.USER, content=user_message)
        ]
        
        log('info', "Calling Claude endpoint for supervisor prompt via SDK serving_endpoints.query()")
        
        response = w.serving_endpoints.query(
            name="databricks-claude-sonnet-4",
            messages=messages,
            max_tokens=3000,  # Supervisor prompts can be longer
            temperature=0.7
        )
        
        # Extract the generated prompt from the response
        generated_prompt = ''
        if response.choices and len(response.choices) > 0:
            generated_prompt = response.choices[0].message.content
        
        if not generated_prompt:
            log('error', f"No content in response: {response}")
            return jsonify({'error': 'No response generated'}), 500
        
        log('info', f"Successfully generated supervisor prompt ({len(generated_prompt)} chars)")
        return jsonify({'prompt': generated_prompt.strip()})
            
    except Exception as e:
        import traceback
        log('error', f"Error generating supervisor prompt: {e}")
        log('error', f"Traceback: {traceback.format_exc()}")
        return jsonify({'error': str(e)}), 500


@app.route('/api/ai/generate-middleware-prompt', methods=['POST'])
def generate_middleware_prompt():
    """Generate an optimized prompt for middleware configuration using Claude.
    
    Request body:
    - middleware_type: The middleware factory type (e.g., 'guardrail', 'todo', 'filesystem', 'subagent', 'tone')
    - context: Description of what the prompt should achieve (optional)
    - existing_prompt: Existing prompt to improve (optional)
    - middleware_name: Name of the middleware being configured (optional)
    
    Returns:
    - prompt: Generated optimized prompt
    """
    try:
        data = request.get_json()
        middleware_type = data.get('middleware_type', '')
        context = data.get('context', '')
        existing_prompt = data.get('existing_prompt', '')
        middleware_name = data.get('middleware_name', '')
        
        if not context and not existing_prompt:
            return jsonify({'error': 'Either context or existing_prompt is required'}), 400
        
        log('info', f"Generating middleware prompt for type '{middleware_type}' using Claude")
        
        # Middleware-type-specific system messages
        middleware_system_prompts: dict[str, str] = {
            'guardrail': """You are an expert prompt engineer specializing in creating guardrail evaluation prompts for AI agents. Your task is to generate an optimized guardrail prompt that evaluates AI responses for quality, safety, and adherence to guidelines.

When creating guardrail prompts, follow these guidelines:
1. Clearly define the role as an expert judge evaluating AI responses
2. Include specific, measurable evaluation criteria
3. Provide clear pass/fail conditions for each criterion
4. Use {inputs} placeholder for the user's original query/conversation
5. Use {outputs} placeholder for the AI's response being evaluated
6. Make the evaluation criteria objective and actionable
7. Include instructions to provide constructive feedback when the response fails
8. Structure the output to include both a pass/fail decision and detailed reasoning

Output ONLY the prompt text, without any additional explanation or markdown formatting.""",

            'todo': """You are an expert prompt engineer specializing in creating system prompts for AI-powered task management and todo list middleware. Your task is to generate an optimized system prompt that guides an AI agent in managing tasks, tracking progress, and organizing work items.

When creating todo system prompts, follow these guidelines:
1. Define how the agent should create, update, and prioritize tasks
2. Include instructions for task categorization and status tracking
3. Provide guidance on breaking down complex tasks into subtasks
4. Include instructions for task dependencies and ordering
5. Define how the agent should report task status and progress
6. Include guidelines for handling blocked or stale tasks
7. Make the instructions clear and actionable

Output ONLY the prompt text, without any additional explanation or markdown formatting.""",

            'filesystem': """You are an expert prompt engineer specializing in creating system prompts for AI-powered filesystem middleware. Your task is to generate an optimized system prompt that guides an AI agent in managing file operations, reading and writing files, and organizing file-based workflows.

When creating filesystem system prompts, follow these guidelines:
1. Define how the agent should navigate and manage files
2. Include safety guidelines for file operations (read vs write permissions)
3. Provide instructions for file organization and naming conventions
4. Include guidance on handling large files and content truncation
5. Define how the agent should handle file conflicts and errors
6. Include instructions for maintaining file state consistency
7. Make the instructions clear and focused on the specific use case

Output ONLY the prompt text, without any additional explanation or markdown formatting.""",

            'subagent': """You are an expert prompt engineer specializing in creating system prompts for AI sub-agent orchestration middleware. Your task is to generate an optimized system prompt that guides a parent agent in delegating tasks to specialized sub-agents.

When creating sub-agent system prompts, follow these guidelines:
1. Define the overall coordination strategy for sub-agents
2. Include instructions for task delegation and assignment
3. Provide guidance on when to use which sub-agent based on capabilities
4. Include instructions for aggregating and synthesizing sub-agent responses
5. Define error handling when sub-agents fail or produce low-quality output
6. Include guidelines for managing sub-agent context and conversation state
7. Make the instructions clear about the parent agent's supervisory role

Output ONLY the prompt text, without any additional explanation or markdown formatting.""",

            'tone': """You are an expert prompt engineer specializing in creating tone and style guidelines for AI agents. Your task is to generate optimized custom tone guidelines that define how an AI agent should communicate.

When creating tone guidelines, follow these guidelines:
1. Define the desired communication style (formal, casual, technical, etc.)
2. Include specific vocabulary preferences and restrictions
3. Provide examples of desired tone in different scenarios
4. Include guidelines for handling sensitive or difficult topics
5. Define appropriate use of humor, empathy, and formality
6. Include instructions for adapting tone based on context
7. Make the guidelines specific and measurable, not vague

Output ONLY the guidelines text, without any additional explanation or markdown formatting.""",
        }
        
        # Default system prompt for unknown middleware types
        default_system = """You are an expert prompt engineer specializing in creating system prompts for AI middleware components. Your task is to generate an optimized prompt for configuring middleware behavior.

When creating middleware prompts, follow these guidelines:
1. Be specific about the middleware's role and purpose
2. Include clear instructions for the expected behavior
3. Provide guidelines for edge cases and error handling
4. Make the instructions actionable and measurable
5. Structure the prompt clearly with sections if needed

Output ONLY the prompt text, without any additional explanation or markdown formatting."""
        
        system_message = middleware_system_prompts.get(middleware_type, default_system)
        
        # Build user message
        user_parts = []
        
        if existing_prompt:
            user_parts.append(f"Please improve and optimize this existing prompt:\n\n{existing_prompt}")
        else:
            user_parts.append(f"Please create an optimized prompt for {middleware_type} middleware configuration.")
        
        if middleware_name:
            user_parts.append(f"\nMiddleware Name: {middleware_name}")
        
        if context:
            user_parts.append(f"\nContext/Requirements: {context}")
        
        user_message = "\n".join(user_parts)
        
        # Call the Databricks serving endpoint
        from databricks.sdk.service.serving import ChatMessage, ChatMessageRole
        
        w = get_workspace_client()
        
        messages = [
            ChatMessage(role=ChatMessageRole.SYSTEM, content=system_message),
            ChatMessage(role=ChatMessageRole.USER, content=user_message)
        ]
        
        log('info', "Calling Claude endpoint for middleware prompt via SDK serving_endpoints.query()")
        
        response = w.serving_endpoints.query(
            name="databricks-claude-sonnet-4",
            messages=messages,
            max_tokens=2000,
            temperature=0.7
        )
        
        generated_prompt = ''
        if response.choices and len(response.choices) > 0:
            generated_prompt = response.choices[0].message.content
        
        if not generated_prompt:
            log('error', f"No content in response: {response}")
            return jsonify({'error': 'No response generated'}), 500
        
        log('info', f"Successfully generated middleware prompt ({len(generated_prompt)} chars)")
        return jsonify({'prompt': generated_prompt.strip()})
            
    except Exception as e:
        import traceback
        log('error', f"Error generating middleware prompt: {e}")
        log('error', f"Traceback: {traceback.format_exc()}")
        return jsonify({'error': str(e)}), 500


# =============================================================================
# Main Entry Point
# =============================================================================

def main():
    """Run the DAO AI Builder server with gunicorn."""
    import subprocess
    import sys
    
    port = os.environ.get('PORT', '8000')
    workers = os.environ.get('WORKERS', '2')
    timeout = os.environ.get('TIMEOUT', '120')
    
    print(f"Starting DAO AI Builder on port {port}")
    if os.environ.get('DATABRICKS_HOST'):
        print(f"DATABRICKS_HOST: {os.environ.get('DATABRICKS_HOST')}")
    
    # Run gunicorn
    cmd = [
        'gunicorn',
        '--bind', f'0.0.0.0:{port}',
        '--workers', workers,
        '--timeout', timeout,
        'app:app'
    ]
    subprocess.run(cmd, check=True)


if __name__ == '__main__':
    # Local development mode - use Flask's built-in server
    from dotenv import load_dotenv
    
    # Load .env file
    env_path = Path(__file__).parent / '.env'
    if env_path.exists():
        load_dotenv(env_path)
    
    # Check if running in production mode
    if os.environ.get('PRODUCTION', 'false').lower() == 'true':
        main()
    else:
        # Databricks Apps use port 8000 by default
        port = int(os.environ.get('PORT', 8000))
        debug = os.environ.get('DEBUG', 'false').lower() == 'true'
        
        print(f"Starting DAO AI Builder (dev mode) on port {port}")
        if os.environ.get('DATABRICKS_HOST'):
            print(f"DATABRICKS_HOST: {os.environ.get('DATABRICKS_HOST')}")
        if os.environ.get('DATABRICKS_TOKEN'):
            print("DATABRICKS_TOKEN: [set]")
        if OAUTH_CLIENT_ID:
            print("OAuth configured")
        
        app.run(host='0.0.0.0', port=port, debug=debug)
