import { Request, Response, Router } from "express";
import { requireAdmin, requireAuth } from "../middleware/authenticate";
import {
  createLocation,
  listLocations,
  LocationWriteResult,
  updateLocation,
} from "../services/locationStore";
import {
  parseCreateLocation,
  parseIdParam,
  parseLocationListFilters,
  parseUpdateLocation,
} from "../validation/adminLocationValidation";

const router = Router();

router.use(requireAuth, requireAdmin);

function sendInvalidRequest(res: Response, message: string): void {
  res.status(400).json({ error: "INVALID_REQUEST", message });
}

function sendWriteError(
  res: Response,
  result: Extract<LocationWriteResult<unknown>, { ok: false }>
): void {
  switch (result.code) {
    case "NOT_FOUND":
      res.status(404).json({ error: "NOT_FOUND", message: "Location not found." });
      return;
  }
}

router.get("/locations", async (req: Request, res: Response) => {
  const filters = parseLocationListFilters(req.query);
  if (!filters) {
    sendInvalidRequest(res, "Invalid filter. Use status.");
    return;
  }

  const locations = await listLocations(filters);
  res.status(200).json({ data: locations });
});

router.post("/locations", async (req: Request, res: Response) => {
  const input = parseCreateLocation(req.body);
  if (!input) {
    sendInvalidRequest(res, "A valid name is required.");
    return;
  }

  const result = await createLocation(input);
  if (!result.ok) {
    sendWriteError(res, result);
    return;
  }

  res.status(201).json({ data: result.data });
});

router.patch("/locations/:id", async (req: Request, res: Response) => {
  const id = parseIdParam(req.params.id);
  if (!id) {
    sendInvalidRequest(res, "A valid location id is required.");
    return;
  }

  const input = parseUpdateLocation(req.body);
  if (!input) {
    sendInvalidRequest(
      res,
      "Provide at least one valid field: name, description, or status."
    );
    return;
  }

  const result = await updateLocation(id, input);
  if (!result.ok) {
    sendWriteError(res, result);
    return;
  }

  res.status(200).json({ data: result.data });
});

export default router;