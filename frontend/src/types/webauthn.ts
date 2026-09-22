export interface PublicKeyCredentialCreationOptionsJSON {
  challenge: string;
  rp: { id?: string; name: string };
  user: { id: string; name: string; displayName: string };
  pubKeyCredParams: PublicKeyCredentialParameters[];
  timeout?: number;
  excludeCredentials?: {
    id: string;
    type: PublicKeyCredentialType;
    transports?: AuthenticatorTransport[];
  }[];
  authenticatorSelection?: AuthenticatorSelectionCriteria;
  attestation?: AttestationConveyancePreference;
  extensions?: AuthenticationExtensionsClientInputs;
}

export interface RegistrationResponseJSON {
  id: string;
  rawId: string;
  response: {
    clientDataJSON: string;
    attestationObject: string;
    transports?: AuthenticatorTransport[];
  };
  type: "public-key";
  clientExtensionResults?: Record<string, unknown>;
  authenticatorAttachment?: string;
}

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
