import { apiRequest } from "./client";
import type {
  AdminLecturer,
  CreateLecturerInput,
  CreateLecturerResponse,
} from "../types/adminLecturer";

export function listAdminLecturers(): Promise<{ data: AdminLecturer[] }> {
  return apiRequest("/admin/lecturers");
}

/**
 * Create a lecturer account with a temporary password.
 *
 * The returned `temporaryPassword` is the one and only copy the client will ever receive: the
 * server stores it only as an Argon2id hash and never returns it again. Show it to the
 * administrator here and drop it from state as soon as they navigate away.
 */
export function createAdminLecturer(input: CreateLecturerInput): Promise<CreateLecturerResponse> {
  return apiRequest("/admin/lecturers", {
    method: "POST",
    body: input,
  });
}
