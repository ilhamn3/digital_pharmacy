# Pharmacy POS - Auth, Roles & Audit API Specification (Step 2)

## 1. Authentication Architecture

### 1.1 Dual-Token Architecture & Security Rules
- **Access Token**: Short-lived JWT (15 minutes). Sent in the `Authorization: Bearer <token>` header. Contains `sub` (User ID), `username`, `fullName`, `role`, and `mustChangePassword`.
- **Refresh Token**: High-entropy 40-byte cryptographically secure random token (7-day validity).
  - Stored in the PostgreSQL `refresh_tokens` table as a SHA-256 digest (`token_hash`).
  - Delivered via an `httpOnly`, `SameSite=Strict`, `secure` (in production) cookie (`path=/api/v1/auth`), as well as returned in JSON body for mobile/terminal clients.
- **Refresh Token Rotation**: Every call to `POST /api/v1/auth/refresh` revokes the used token and issues a new pair.
- **Malicious Reuse Detection (Compromise Defense)**: If an already-revoked refresh token is presented, the system treats it as token theft/replay, automatically invalidates **ALL** active refresh tokens for that user account, and logs a security violation in the audit log.
- **Brute-Force Protection & Lockout**: 5 consecutive failed login attempts trigger an automatic 15-minute account lockout (`users.locked_until`). Successful login clears the failed count.
- **Must Change Password Flow**: Users bootstrapped with a temporary password (`must_change_password = true`) are strictly restricted from accessing business endpoints until they call `POST /api/v1/auth/change-password`.

---

## 2. Role-Based Access Control (RBAC) & Data Masking

### 2.1 Role Permission Matrix

| Capability | Owner | Pharmacist | Cashier |
| :--- | :---: | :---: | :---: |
| **User & Staff Management** (`/api/v1/users`) | Yes | No | No |
| **System Audit Logs** (`/api/v1/audit-logs`) | Yes | No | No |
| **Shop Settings** (`/api/v1/settings`) | Yes | No | No |
| **Purchases & GRN Entry** | Yes | Yes | No |
| **Stock Adjustments & Write-offs** | Yes | Yes | No |
| **Prescription (Rx) Dispensing** | Yes | Yes | Yes |
| **Point of Sale Billing** | Yes | Yes | Yes |
| **Returns & Refunds** | Yes | Yes | No |
| **View Purchase / Cost Prices** | **Yes** | **Yes** | **NEVER** |

### 2.2 Cashier Cost Price Sanitizer Middleware
- When `req.user.role === 'cashier'`, the global `cashierDataSanitizer` interceptor recursively scrubs all fields matching `cost_price`, `unit_cost_price`, `unit_cost`, and purchase price details before the JSON response leaves the server.
- The cashier interface never receives wholesale pricing under any circumstance.

---

## 3. Endpoints Specification

### 3.1 Authentication (`/api/v1/auth`)

#### `POST /api/v1/auth/login`
- **Body**: `{ "username": "admin", "password": "password123" }`
- **Response** (200 OK):
  ```json
  {
    "accessToken": "eyJhbGciOi...",
    "refreshToken": "48f12a...",
    "user": {
      "id": "uuid",
      "username": "admin",
      "fullName": "Dr. Rohan Jayasuriya",
      "role": "owner",
      "isActive": true,
      "mustChangePassword": false
    }
  }
  ```

#### `POST /api/v1/auth/refresh`
- **Body**: `{ "refreshToken": "48f12a..." }` (or via `httpOnly` cookie)
- **Response** (200 OK): Rotated token pair and profile.
- **Error** (403 Forbidden): `TOKEN_REUSE_COMPROMISED` if an already-revoked token is submitted.

#### `POST /api/v1/auth/logout`
- **Body**: Optional `{ "refreshToken": "..." }`
- **Response** (200 OK): Revokes refresh token, clears cookie, logs `USER_LOGOUT`.

#### `POST /api/v1/auth/change-password`
- **Headers**: `Authorization: Bearer <token>`
- **Body**: `{ "oldPassword": "...", "newPassword": "..." }`
- **Response** (200 OK): Updates password hash, sets `must_change_password = false`, revokes all previous sessions, issues fresh token pair.

#### `GET /api/v1/auth/me`
- **Headers**: `Authorization: Bearer <token>`
- **Response** (200 OK): Authenticated user payload.

---

### 3.2 User Management (`/api/v1/users`) — Owner Only
- `GET /api/v1/users`: List all users.
- `POST /api/v1/users`: Create a new user (`username`, `password`, `fullName`, `role`, `email`).
- `PUT /api/v1/users/:id`: Update user profile, role, or active status.
- `POST /api/v1/users/:id/reset-password`: Reset user password and mark `must_change_password = true`.

---

### 3.3 Audit Trail (`/api/v1/audit-logs`) — Owner Only
- `GET /api/v1/audit-logs?action=...&entity=...&userId=...&limit=50&offset=0`
- Lists immutable audit logs.
- Sensitive fields (`password`, `token`, `secret`, `hash`) are automatically sanitized to `"[REDACTED]"` at capture time.

