export type AdminEnrollStudentRequest = {
  studentId: number;
};

export type AdminEnrollStudentResponse = {
  registration: {
    id: number;
    studentId: number;
    courseOfferingId: number;
    status: RegistrationStatus;
    createdAt: string;
    updatedAt: string;
  };
};

export type RegistrationStatus = "ENROLLED" | "DROPPED" | "COMPLETED";

export type OfferingStatus = "OPEN" | "CLOSED";

export type AdminCourseOfferingRegistrations = {
  courseOffering: {
    id: number;
    courseCode: string;
    courseTitle: string;
    academicSession: string;
    semester: string;
    level: {
      id: number;
      name: number;
    };
    status: OfferingStatus;
  };
  total: number;
  items: AdminRegistrationRosterItem[];
};

export type AdminRegistrationRosterItem = {
  registrationId: number;
  studentId: number;
  matricNumber: string;
  studentName: string;
  department: {
    id: number;
    name: string;
    code: string;
  };
  level: {
    id: number;
    name: number;
  };
  status: RegistrationStatus;
  registeredAt: string;
};

export type AdminCourseOfferingRegistrationsFilters = {
  status?: RegistrationStatus;
  matricNumber?: string;
  studentName?: string;
  limit?: number;
  offset?: number;
};