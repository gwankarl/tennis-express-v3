import { index, route, type RouteConfig } from '@react-router/dev/routes';

export default [
  index('./routes/home.tsx'),
  route('register', './routes/register.tsx'),
  route('verify-email', './routes/verify-email.tsx'),
  route('resend-verification', './routes/resend-verification.tsx'),
  route('*', './routes/not-found.tsx'),
] satisfies RouteConfig;
