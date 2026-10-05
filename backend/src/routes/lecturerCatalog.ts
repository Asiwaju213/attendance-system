import { Request, Response, Router } from "express";
import { requireAuth, requireLecturer } from "../middleware/authenticate";
import { listLecturerOpenOfferings } from "../services/courseOfferingStore";

const router = Router();

router.use(requireAuth, requireLecturer);

router.get("/course-offerings", async (req: Request, res: Response) => {
  const result = await listLecturerOpenOfferings(req.user!.id);
  if (!result.ok) {
    res.status(404).json({
      error: "LECTURER_NOT_FOUND",
      message: "The lecturer profile could not be found.",
    });
    return;
  }
  res.status(200).json({ data: result.data });
});

export default router;