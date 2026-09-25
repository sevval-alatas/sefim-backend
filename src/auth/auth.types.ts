export interface SignupRequest {
  email: string;
  password: string;
  username?: string;
  name?: string;
}

export interface LoginRequest {
  email: string;
  password: string;
}