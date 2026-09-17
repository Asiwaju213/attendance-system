import { apiRequest } from "./client";
import type { AcademicSession, Semester } from "../types/academicPeriod";

export function listAcademicSessions(): Promise<{ data: AcademicSession[] }> {
  return apiRequest("/admin/academic-sessions");
}

export function createAcademicSession(
  name: string
): Promise<{ data: AcademicSession }> {
  return apiRequest("/admin/academic-sessions", {
    method: "POST",
    body: { name },
  });
}

export function updateAcademicSession(
  id: number,
  input: { name?: string; isActive?: boolean }
): Promise<{ data: AcademicSession }> {
  return apiRequest(`/admin/academic-sessions/${id}`, {
    method: "PATCH",
    body: input,
  });
}

export function listSemesters(): Promise<{ data: Semester[] }> {
  return apiRequest("/admin/semesters");
}

export function updateSemester(
  id: number,
  name: string
): Promise<{ data: Semester }> {
  return apiRequest(`/admin/semesters/${id}`, {
    method: "PATCH",
    body: { name },
  });
}