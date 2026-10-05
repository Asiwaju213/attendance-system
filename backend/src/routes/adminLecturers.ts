import { Request, Response, Router } from "express";
import { hashPassword } from "../lib/passwords";
import { requireAdmin, requireAuth } from "../middleware/authenticate";
import { createLecturerAccount, listActiveLecturers } from "../services/adminLecturerStore";
import { parseCreateLecturer } from "../validation/adminLecturerValidation";

const router = Router();

router.use(requireAuth, requireAdmin);

router.get("/lecturers", async (_req: Request, res: Response) => {
  const lecturers = await listActiveLecturers();
  res.status(200).json({ data: lecturers });
});

/**
 * Create a lecturer account with a temporary password.
 *
 * The temporary password is echoed back exactly once, in this response, because the admin has to
 * hand it to the lecturer out of band. It is stored only as an Argon2id hash, and it is never
 * readable again: the listing endpoint above returns no credential material at all.
 */
router.post("/lecturers", async (req: Request, res: Response) => {
  const input = parseCreateLecturer(req.body);
  if (!input) {
    res.status(400).json({
      error: "INVALID_REQUEST",
      message:
        "Request body must contain exactly staffId, name, departmentId and a temporaryPassword of at least 8 characters.",
    });
    return;
  }

  try {
    const passwordHash = await hashPassword(input.temporaryPassword);
    const result = await createLecturerAccount(req.user!.id, input, passwordHash);
    if (!result.ok) {
      if (result.code === "DEPARTMENT_NOT_FOUND") {
        res.status(404).json({
          error: "DEPARTMENT_NOT_FOUND",
          message: "The selected department no longer exists.",
        });
        return;
      }
      res.status(409).json({
        error: "CONFLICT",
        message: "A lecturer with this staff ID already exists.",
      });
      return;
    }

    res.status(201).json({
      data: result.data,
      temporaryPassword: input.temporaryPassword,
    });
  } catch (error) {
    console.error("Admin lecturer create error.", (error as Error).message);
    res.status(500).json({
      error: "INTERNAL_ERROR",
      message: "An unexpected error occurred while creating the lecturer account.",
    });
  }
});

export default router;
