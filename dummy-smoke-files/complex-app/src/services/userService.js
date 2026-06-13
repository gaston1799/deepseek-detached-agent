import seedUsers from "../data/users.json" with { type: "json" };

export function listUsers() {
  return seedUsers.map((user) => ({
    ...user,
    label: `${user.name} <${user.email}>`,
    marker: "user"
  }));
}

