import axios from 'axios';
import { fetchAuthSession } from 'aws-amplify/auth';

/**
 * Axios instance pre-configured with the API base URL.
 * A request interceptor automatically attaches the Cognito access token
 * to every outbound request. Amplify handles silent token refresh.
 */
const api = axios.create({
  baseURL: import.meta.env.VITE_API_URL as string,
  headers: {
    'Content-Type': 'application/json',
  },
});

api.interceptors.request.use(async (config) => {
  try {
    const session = await fetchAuthSession();
    const token = session.tokens?.accessToken?.toString();
    if (token) {
      config.headers.Authorization = `Bearer ${token}`;
    }
  } catch {
    // If token fetch fails, let the request proceed — API Gateway will return 401
  }
  return config;
});

export default api;
