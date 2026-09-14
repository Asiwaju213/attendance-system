import { Request, Response, Router } from "express";
import { requireAuth, requireLecturer } from "../middleware/authenticate";
import { listActiveNetworksForLecturer } from "../services/attendanceNetworkStore";
import { listLecturerOpenOfferings } from "../services/courseOfferingStore";
import { listActiveLocationsForLecturer } from "../services/locationStore";

const router = Router();

router.use(requireAuth, requireLecturer);

router.get("/attendance-networks", async (_req: Request, res: Response) => {
  const networks = await listActiveNetworksForLecturer();
  res.status(200).json({ data: networks });
});

router.get("/locations", async (_req: Request, res: Response) => {
  const locations = await listActiveLocationsForLecturer();
  res.status(200).json({ data: locations });
});

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