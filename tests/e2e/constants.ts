export const E2E_PASSWORD = "auth-flow-test-password";

export const E2E_STUDENT = {
  matricNumber: "E2E/STU/0001",
  password: E2E_PASSWORD,
  name: "E2E Student",
};

export const E2E_STUDENT_TWO = {
  matricNumber: "E2E/STU/0002",
  password: E2E_PASSWORD,
  name: "E2E Student Two",
};

export const E2E_STUDENT_THREE = {
  matricNumber: "E2E/STU/0003",
  password: E2E_PASSWORD,
  name: "E2E Student Three",
};

export const E2E_STUDENT_PENDING = {
  matricNumber: "E2E/STU/0004",
  name: "E2E Student Pending",
};

export const E2E_STUDENT_NO_COURSES = {
  matricNumber: "E2E/STU/0005",
  password: E2E_PASSWORD,
  name: "E2E Student No Courses",
};

export const E2E_STUDENT_ACTIVE_MANAGEMENT = {
  matricNumber: "E2E/STU/0010",
  password: E2E_PASSWORD,
  name: "E2E Active Management",
};

export const E2E_STUDENT_INACTIVE_MANAGEMENT = {
  matricNumber: "E2E/STU/0011",
  password: E2E_PASSWORD,
  name: "E2E Inactive Management",
};

export const E2E_STUDENT_PENDING_MANAGEMENT = {
  matricNumber: "E2E/STU/0012",
  name: "E2E Pending Management",
};

export const E2E_STUDENT_RESET_MANAGEMENT = {
  matricNumber: "E2E/STU/0013",
  password: E2E_PASSWORD,
  name: "E2E Reset Management",
};

export const E2E_LECTURER = {
  staffId: "E2E/LEC/0001",
  password: E2E_PASSWORD,
  name: "E2E Lecturer",
};

export const E2E_MONITOR_LECTURER = {
  staffId: "E2E/LEC/0002",
  password: E2E_PASSWORD,
  name: "E2E Monitor Lecturer",
};

export const E2E_COURSE_CODE_TWO = "E2E-102";

export const E2E_ADMIN = {
  username: "e2e_admin",
  password: E2E_PASSWORD,
  name: "E2E Admin",
};

export const E2E_IMPORT_STUDENTS = [
  { matricNumber: "E2E/IMP/0001", name: "Ada Import" },
  { matricNumber: "E2E/IMP/0002", name: "Bello Import" },
  { matricNumber: "E2E/IMP/0003", name: "Chioma Import" },
] as const;

export const E2E_IMPORT_DEPARTMENT = {
  label: "E2E Test Department (E2EFLOW)",
};