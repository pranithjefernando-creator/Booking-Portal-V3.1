import { Router } from "../lib/http.js";
const router = Router();
router.get("/", (req, res) => res.json({ total: 0, items: [] }));
export default router;
