export async function deepSeekHttpError(response) {
  const text = await response.text();
  let detail = text;

  try {
    const data = JSON.parse(text);
    const error = data?.error;
    if (error?.message) {
      const bits = [`DeepSeek HTTP ${response.status}: ${error.message}`];
      if (error.code) bits.push(`code=${error.code}`);
      if (error.type) bits.push(`type=${error.type}`);
      detail = bits.join(" ");
    }
  } catch {
    if (!detail) detail = response.statusText || "Request failed";
  }

  return new Error(detail);
}
