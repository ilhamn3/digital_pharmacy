export class ApiError extends Error {
  status: number;
  code: string;
  details?: any;

  constructor(status: number, message: string, code: string = 'API_ERROR', details?: any) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

let inMemoryToken: string | null = null;
let unauthorizedHandler: (() => void) | null = null;
let isRefreshing = false;
let refreshSubscribers: ((token: string | null) => void)[] = [];

export function setAccessToken(token: string | null) {
  inMemoryToken = token;
}

export function getAccessToken(): string | null {
  return inMemoryToken;
}

export function setUnauthorizedHandler(handler: () => void) {
  unauthorizedHandler = handler;
}

function onRefreshed(token: string | null) {
  refreshSubscribers.forEach((cb) => cb(token));
  refreshSubscribers = [];
}

/**
 * Attempts silent token refresh via httpOnly cookie
 */
export async function refreshAccessToken(): Promise<string | null> {
  try {
    const res = await fetch('/api/v1/auth/refresh', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      credentials: 'include'
    });

    if (!res.ok) {
      setAccessToken(null);
      return null;
    }

    const data = await res.json();
    if (data.accessToken) {
      setAccessToken(data.accessToken);
      return data.accessToken;
    }
    return null;
  } catch (err) {
    console.error('Silent refresh failed:', err);
    setAccessToken(null);
    return null;
  }
}

/**
 * Main API request wrapper with transparent 401 silent refresh
 */
export async function apiRequest<T = any>(
  endpoint: string,
  options: RequestInit = {}
): Promise<T> {
  const origin = typeof window !== 'undefined' && window.location?.origin && window.location.origin !== 'null'
    ? window.location.origin
    : 'http://localhost:3000';

  const path = endpoint.startsWith('/api')
    ? endpoint
    : `/api/v1${endpoint.startsWith('/') ? '' : '/'}${endpoint}`;

  const url = endpoint.startsWith('http') ? endpoint : `${origin}${path}`;

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(options.headers as Record<string, string> || {})
  };

  if (inMemoryToken) {
    headers['Authorization'] = `Bearer ${inMemoryToken}`;
  }

  const config: RequestInit = {
    ...options,
    headers,
    credentials: 'include'
  };

  let response: Response;
  try {
    response = await fetch(url, config);
  } catch (netErr: any) {
    throw new ApiError(0, netErr.message || 'Network error: could not connect to pharmacy server', 'NETWORK_ERROR');
  }

  // Handle 401 Unauthorized with silent token refresh
  if (response.status === 401 && !url.includes('/auth/login') && !url.includes('/auth/refresh')) {
    if (!isRefreshing) {
      isRefreshing = true;
      const newToken = await refreshAccessToken();
      isRefreshing = false;

      if (newToken) {
        onRefreshed(newToken);
        // Retry original request with new token
        headers['Authorization'] = `Bearer ${newToken}`;
        response = await fetch(url, { ...config, headers });
      } else {
        onRefreshed(null);
        if (unauthorizedHandler) {
          unauthorizedHandler();
        }
        throw new ApiError(401, 'Session expired. Please log in again to continue.', 'UNAUTHORIZED');
      }
    } else {
      // Wait for ongoing refresh
      const retryToken = await new Promise<string | null>((resolve) => {
        refreshSubscribers.push((token) => resolve(token));
      });

      if (retryToken) {
        headers['Authorization'] = `Bearer ${retryToken}`;
        response = await fetch(url, { ...config, headers });
      } else {
        if (unauthorizedHandler) {
          unauthorizedHandler();
        }
        throw new ApiError(401, 'Session expired. Please log in again.', 'UNAUTHORIZED');
      }
    }
  }

  const contentType = response.headers.get('content-type');
  let data: any = null;
  if (contentType && contentType.includes('application/json')) {
    data = await response.json();
  } else {
    data = await response.text();
  }

  if (!response.ok) {
    const errorMsg = data?.message || data?.error || (typeof data === 'string' ? data : 'An unexpected error occurred');
    const errorCode = data?.error || `HTTP_${response.status}`;
    throw new ApiError(response.status, errorMsg, errorCode, data?.details);
  }

  return data as T;
}

export const api = {
  get: <T = any>(endpoint: string, options?: RequestInit) =>
    apiRequest<T>(endpoint, { ...options, method: 'GET' }),

  post: <T = any>(endpoint: string, body?: any, options?: RequestInit) =>
    apiRequest<T>(endpoint, {
      ...options,
      method: 'POST',
      body: body !== undefined ? JSON.stringify(body) : undefined
    }),

  put: <T = any>(endpoint: string, body?: any, options?: RequestInit) =>
    apiRequest<T>(endpoint, {
      ...options,
      method: 'PUT',
      body: body !== undefined ? JSON.stringify(body) : undefined
    }),

  patch: <T = any>(endpoint: string, body?: any, options?: RequestInit) =>
    apiRequest<T>(endpoint, {
      ...options,
      method: 'PATCH',
      body: body !== undefined ? JSON.stringify(body) : undefined
    }),

  delete: <T = any>(endpoint: string, options?: RequestInit) =>
    apiRequest<T>(endpoint, { ...options, method: 'DELETE' })
};
