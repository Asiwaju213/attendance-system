import { Request, Response, Router } from "express";
import { requireAdmin, requireAuth } from "../middleware/authenticate";
import { OrganizationWriteResult } from "../services/organizationStore";
import {
  createDepartment,
  createFaculty,
  listDepartments,
  listFaculties,
  updateDepartment,
  updateFaculty,
} from "../services/organizationStore";
import {
  parseCreateDepartment,
  parseCreateFaculty,
  parseIdParam,
  parseUpdateDepartment,
  parseUpdateFaculty,
} from "../validation/adminOrgValidation";

const router = Router();

router.use(requireAuth, requireAdmin);

function sendInvalidRequest(res: Response, message: string): void {
  res.status(400).json({ error: "INVALID_REQUEST", message });
}

function sendWriteError(
  res: Response,
  result: Extract<OrganizationWriteResult<unknown>, { ok: false }>
): void {
  switch (result.code) {
    case "NOT_FOUND":
      res.status(404).json({ error: "NOT_FOUND", message: "Record not found." });
      return;
    case "FACULTY_NOT_FOUND":
      res
        .status(404)
        .json({ error: "FACULTY_NOT_FOUND", message: "The faculty does not exist." });
      return;
    case "CONFLICT":
      res
        .status(409)
        .json({ error: "CONFLICT", message: "A record with this code already exists." });
      return;
  }
}

router.get("/faculties", async (_req: Request, res: Response) => {
  const faculties = await listFaculties();
  res.status(200).json({ data: faculties });
});

router.post("/faculties", async (req: Request, res: Response) => {
  const input = parseCreateFaculty(req.body);
  if (!input) {
    sendInvalidRequest(res, "A valid faculty name and code are required.");
    return;
  }

  const result = await createFaculty(input);
  if (!result.ok) {
    sendWriteError(res, result);
    return;
  }

  res.status(201).json({ data: result.data });
});

router.patch("/faculties/:id", async (req: Request, res: Response) => {
  const id = parseIdParam(req.params.id);
  if (!id) {
    sendInvalidRequest(res, "A valid faculty id is required.");
    return;
  }

  const input = parseUpdateFaculty(req.body);
  if (!input) {
    sendInvalidRequest(
      res,
      "Provide at least one valid field: name, code, or status."
    );
    return;
  }

  const result = await updateFaculty(id, input);
  if (!result.ok) {
    sendWriteError(res, result);
    return;
  }

  res.status(200).json({ data: result.data });
});

router.get("/departments", async (_req: Request, res: Response) => {
  const departments = await listDepartments();
  res.status(200).json({ data: departments });
});

router.post("/departments", async (req: Request, res: Response) => {
  const input = parseCreateDepartment(req.body);
  if (!input) {
    sendInvalidRequest(
      res,
      "A valid department name, code, and facultyId are required."
    );
    return;
  }

  const result = await createDepartment(input);
  if (!result.ok) {
    sendWriteError(res, result);
    return;
  }

  res.status(201).json({ data: result.data });
});

router.patch("/departments/:id", async (req: Request, res: Response) => {
  const id = parseIdParam(req.params.id);
  if (!id) {
    sendInvalidRequest(res, "A valid department id is required.");
    return;
  }

  const input = parseUpdateDepartment(req.body);
  if (!input) {
    sendInvalidRequest(
      res,
      "Provide at least one valid field: name, code, facultyId, or status."
    );
    return;
  }

  const result = await updateDepartment(id, input);
  if (!result.ok) {
    sendWriteError(res, result);
    return;
  }

  res.status(200).json({ data: result.data });
});

export default router;