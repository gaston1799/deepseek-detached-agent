export function requireAuth(context) {
  if (!context || !context.user) {
    throw new Error("not authenticated");
  }
  return context.user;
}

