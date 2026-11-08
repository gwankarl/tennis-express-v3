import { index, route, type RouteConfig } from '@react-router/dev/routes';

export default [
  index('./routes/home.tsx'),
  route('register', './routes/auth/register.tsx'),
  route('verify-email', './routes/auth/verify-email.tsx'),
  route('resend-verification', './routes/auth/resend-verification.tsx'),
  route('login', './routes/auth/login.tsx'),
  route('sign-out', './routes/auth/sign-out.ts'),
  route('account', './routes/account/index.tsx'),
  route('account/profile', './routes/account/profile.tsx'),
  route('account/change-password', './routes/account/change-password.tsx'),
  route('forgot-password', './routes/auth/forgot-password.tsx'),
  route('reset-password', './routes/auth/reset-password.tsx'),
  route('*', './routes/not-found.tsx'),
] satisfies RouteConfig;
