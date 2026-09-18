import { Request, Response, Router } from "express";
import { requireAuth, requireStudent } from "../middleware/authenticate";
import { getStudentAttendanceHistory } from "../services/studentAttendanceHistoryStore";

const router = Router();

router.use(requireAuth, requireStudent);

// GET /api/student/attendance/history
// Completed (ENDED) attendance history for every enrolled, active course of the
// authenticated student. Attendance status comes from the student's identity in
// req.user.id — never from client-supplied parameters.
router.get("/attendance/history", async (req: Request, res: Response) => {
  const result = await getStudentAttendanceHistory(req.user!.id);
  if (!result.ok) {
    res.status(404).json({
      error: "STUDENT_NOT_FOUND",
      message: "The student profile could not be found.",
    });
    return;
  }
  res.status(200).json({ data: result.data });
});

export default router;
