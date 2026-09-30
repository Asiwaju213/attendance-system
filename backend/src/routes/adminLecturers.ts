import { Request, Response, Router } from "express";
import { requireAdmin, requireAuth } from "../middleware/authenticate";
import { listActiveLecturers } from "../services/adminLecturerStore";

const router = Router();

router.use(requireAuth, requireAdmin);

router.get("/lecturers", async (_req: Request, res: Response) => {
  const lecturers = await listActiveLecturers();
  res.status(200).json({ data: lecturers });
});

export default router;