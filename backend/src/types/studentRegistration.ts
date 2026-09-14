export interface RegistrationDepartment {
  id: number;
  name: string;
  code: string;
}

export interface RegistrationLevel {
  id: number;
  name: number;
}

export interface RegistrationIdentityPreview {
  matricNumber: string;
  name: string;
  department: RegistrationDepartment;
  level: RegistrationLevel;
  challengeToken: string;
}