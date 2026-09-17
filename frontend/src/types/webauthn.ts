export interface PublicKeyCredentialRequestOptionsJSON {
  challenge: string;
  timeout?: number;
  rpId?: string;
  allowCredentials?: {
    id: string;
    type: "public-key";
    transports?: string[];
  }[];
  userVerification?: UserVerificationRequirement;
  extensions?: Record<string, unknown>;
}

export interface AuthenticationResponseJSON {
  id: string;
  rawId: string;
  response: {
    clientDataJSON: string;
    authenticatorData: string;
    signature: string;
    userHandle?: string;
  };
  type: "public-key";
  clientExtensionResults?: Record<string, unknown>;
  authenticatorAttachment?: string;
}
