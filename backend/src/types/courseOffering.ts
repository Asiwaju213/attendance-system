export const OFFERING_STATUSES = ["OPEN", "CLOSED"] as const;

export type OfferingStatus = (typeof OFFERING_STATUSES)[number];

export const REGISTRATION_STATUSES = ["ENROLLED", "DROPPED", "COMPLETED"] as const;

export type RegistrationStatus = (typeof REGISTRATION_STATUSES)[number];

export interface CourseOffering {
  id: number;
  courseId: number;
  courseCode: string;
  courseTitle: string;
  levelId: number;
  levelName: number;
  academicSessionId: number;
  academicSessionName: string;
  semesterId: number;
  semesterName: string;
  status: OfferingStatus;
  createdAt: Date;
  updatedAt: Date;
}

export interface AssignedLecturer {
  id: number;
  userId: number;
  staffId: string;
  name: string;
  departmentId: number;
  assignedAt: Date;
}

export interface OfferingForLecturer {
  id: number;
  courseCode: string;
  courseTitle: string;
  levelName: number;
  academicSessionName: string;
  semesterName: string;
  status: OfferingStatus;
}

export interface RegistrationRosterItem {
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
  registeredAt: Date;
}

export interface CourseOfferingRegistrations {
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
  items: RegistrationRosterItem[];
}
