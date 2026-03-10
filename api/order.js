// api/order.js
export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }
  // Poți adăuga aici logica ta reală!
  return res.status(200).json({ status: "ok" });
}