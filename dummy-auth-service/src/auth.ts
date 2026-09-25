import { Request, Response } from 'express';

interface LoginBody {
  email: string; // DRIFT 1: Code expects email, docs claim username
  password: string;
}

interface User {
  id: string;
  name: string;
  role: string;
}

const USERS_DB: User[] = [
  { id: 'usr_101', name: 'Alice', role: 'admin' },
  { id: 'usr_102', name: 'Bob', role: 'developer' },
];

/**
 * Handles user login
 * POST /api/v1/auth/login
 */
export async function loginHandler(req: Request<{}, {}, LoginBody>, res: Response) {
  const { email, password } = req.body;

  // Validation strictly checks email
  if (!email || !password) {
    return res.status(400).json({ error: 'Missing required field: email or password' });
  }

  // DRIFT 2: Code returns Bearer JWT, docs claim Redis cookies
  const token = 'jwt_token_sample_header_payload_sig';
  return res.status(200).json({
    status: 'success',
    token_type: 'Bearer',
    access_token: token,
  });
}

/**
 * Fetches all system users
 * GET /api/v1/users
 */
export async function listUsersHandler(req: Request, res: Response) {
  // Check Bearer auth header
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized: Missing Bearer Token' });
  }

  // DRIFT 3: Code returns wrapped object { users, total }, docs claim raw array
  return res.status(200).json({
    users: USERS_DB,
    total: USERS_DB.length,
    page: 1,
  });
}