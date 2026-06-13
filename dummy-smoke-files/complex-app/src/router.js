export function createRouter() {
  const routes = [];
  return {
    use(path, handler) {
      routes.push({ path, handler });
    },
    list() {
      return routes.map((route) => route.path);
    }
  };
}

