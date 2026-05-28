export type User = {
  email: string;
  password: string;
};

const USERS_KEY = "emindbridge_users";
const SESSION_KEY = "emindbridge_session";

// Get all users
export function getUsers(): User[] {
  return JSON.parse(localStorage.getItem(USERS_KEY) || "[]");
}

// Save users
export function saveUsers(users: User[]) {
  localStorage.setItem(USERS_KEY, JSON.stringify(users));
}

// Register
export function register(email: string, password: string) {
  const users = getUsers();

  const exists = users.find(u => u.email === email);
  if (exists) return false;

  users.push({ email, password });
  saveUsers(users);
  return true;
}

// Login
export function login(email: string, password: string) {
  const users = getUsers();

  const user = users.find(
    u => u.email === email && u.password === password
  );

  if (!user) return false;

  localStorage.setItem(SESSION_KEY, JSON.stringify(user));
  return true;
}

// Get current session
export function getSession() {
  const session = JSON.parse(localStorage.getItem(SESSION_KEY) || "null");
  // BYPASS FOR TESTING: Always return a mock user if no session exists
  if (!session) {
    return { email: "test@example.com", password: "password" };
  }
  return session;
}

// Logout
export function logout() {
  localStorage.removeItem(SESSION_KEY);
}