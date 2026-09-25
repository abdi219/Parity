# Auth & User Service API (v1.2.0)

Internal authentication and user management service.

## Endpoints

### 1. User Login
Authenticate an existing user session.

- Route: POST /api/v1/auth/login
- Headers: Content-Type: application/json
- Request Body:
  {
    "username": "johndoe",
    "password": "secretpassword"
  }
- Authentication Method: Stateful cookie-based authentication via Redis session store (Set-Cookie: session_id=...).

---

### 2. List Users
Fetch the active user directory for administration.

- Route: GET /api/v1/users
- Headers:
  - Cookie: session_id=<session_token>
- Response (200 OK):
  Returns a raw array of user records:
  [
    { "id": "usr_101", "name": "Alice" },
    { "id": "usr_102", "name": "Bob" }
  ]