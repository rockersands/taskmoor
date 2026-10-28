import { randomBytes, X509Certificate } from 'node:crypto';
import { deflateRawSync } from 'node:zlib';
import { DOMParser } from '@xmldom/xmldom';
import { SignedXml } from 'xml-crypto';

/**
 * SAML 2.0 service provider (M1-081, IAM-002, ADR-019): AuthnRequests over HTTP-Redirect,
 * responses over HTTP-POST, service provider metadata and identity provider metadata import.
 *
 * Responses are read defensively, because XML signatures leave room for signature wrapping:
 *
 * - The document must be plain: no DTD, entity, comment, processing instruction or CDATA; one
 *   Response at the root holding exactly one Assertion (and no encrypted one); no element
 *   anywhere else named Assertion or Response; IDs unique across the document.
 * - Signatures may sit only directly in the Response or directly in the Assertion, at most one
 *   each, with one Reference that points at the element enclosing it, no ds:Object, and only
 *   RSA-SHA-256/512, SHA-256/512 digests and the plain (comment-free) canonicalizations.
 * - Signatures are checked with xml-crypto against the provider's configured certificates
 *   only; certificates inside the response (KeyInfo) are never trusted.
 * - Everything is then read from the canonical bytes the signature covered (re-parsed), never
 *   from the received document: the assertion's own signed copy, or the assertion inside the
 *   signed Response. A signature that is present but does not verify fails the whole response.
 * - Then issuer, destination, recipient, audience, time limits (with a small clock skew) and the
 *   bearer confirmation are checked. Replay and InResponseTo are the caller's (they need state).
 */
export const SAML_NS = {
  protocol: 'urn:oasis:names:tc:SAML:2.0:protocol',
  assertion: 'urn:oasis:names:tc:SAML:2.0:assertion',
  metadata: 'urn:oasis:names:tc:SAML:2.0:metadata',
  dsig: 'http://www.w3.org/2000/09/xmldsig#',
} as const;

export const SAML_BINDING = {
  redirect: 'urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect',
  post: 'urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST',
} as const;

export const NAME_ID_FORMAT = {
  unspecified: 'urn:oasis:names:tc:SAML:1.1:nameid-format:unspecified',
  email: 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress',
  persistent: 'urn:oasis:names:tc:SAML:2.0:nameid-format:persistent',
  transient: 'urn:oasis:names:tc:SAML:2.0:nameid-format:transient',
} as const;

const STATUS_SUCCESS = 'urn:oasis:names:tc:SAML:2.0:status:Success';
const BEARER = 'urn:oasis:names:tc:SAML:2.0:cm:bearer';

const SIGNATURE_ALGORITHMS = new Set([
  'http://www.w3.org/2001/04/xmldsig-more#rsa-sha256',
  'http://www.w3.org/2001/04/xmldsig-more#rsa-sha512',
]);
const DIGEST_ALGORITHMS = new Set([
  'http://www.w3.org/2001/04/xmlenc#sha256',
  'http://www.w3.org/2001/04/xmlenc#sha512',
]);
const CANONICALIZATIONS = new Set([
  'http://www.w3.org/2001/10/xml-exc-c14n#',
  'http://www.w3.org/TR/2001/REC-xml-c14n-20010315',
]);
const ENVELOPED = 'http://www.w3.org/2000/09/xmldsig#enveloped-signature';
const TRANSFORMS = new Set([...CANONICALIZATIONS, ENVELOPED]);

/** How far the identity provider's clock may be from ours. */
export const SAML_CLOCK_SKEW_MS = 2 * 60 * 1000;
/** How deep elements may nest in a response or metadata. */
const MAX_DEPTH = 64;
/** The largest response accepted, decoded. */
export const SAML_MAX_RESPONSE_BYTES = 256 * 1024;

/**
 * Why a response was refused. `vouched` is true once a signature of the provider verified:
 * the provider stands behind what was refused, so it belongs in the audit log; anyone can
 * produce the others.
 */
export type SamlFailure =
  | 'malformed'
  | 'encrypted'
  | 'wrapped'
  | 'unsigned'
  | 'bad_signature'
  | 'status'
  | 'issuer'
  | 'destination'
  | 'recipient'
  | 'audience'
  | 'expired'
  | 'not_yet_valid'
  | 'in_response_to'
  | 'subject';

export class SamlError extends Error {
  constructor(
    readonly reason: SamlFailure,
    readonly vouched: boolean,
    message: string,
  ) {
    super(message);
    this.name = 'SamlError';
  }
}

function refuse(reason: SamlFailure, message: string, vouched = false): never {
  throw new SamlError(reason, vouched, message);
}

// ---- XML ----

const ELEMENT = 1;
const TEXT = 3;
const CDATA = 4;
const ENTITY_REFERENCE = 5;
const PROCESSING_INSTRUCTION = 7;
const COMMENT = 8;
const DOCUMENT_TYPE = 10;

/**
 * Parses XML strictly: any parser complaint, a DTD or an entity declaration refuses it. Comments
 * are allowed only where the caller says so (metadata pasted by an administrator).
 */
export function parseXml(xml: string): Document {
  if (/<!DOCTYPE|<!ENTITY/i.test(xml))
    refuse('malformed', 'Document type declarations are refused');
  let problem: string | null = null;
  const note = (message: unknown) => {
    problem ??= String(message);
  };
  let doc: Document | undefined;
  try {
    doc = new DOMParser({
      errorHandler: { warning: note, error: note, fatalError: note },
    }).parseFromString(xml, 'text/xml');
  } catch (error) {
    note(error);
  }
  if (problem !== null || !doc?.documentElement) refuse('malformed', 'Not well-formed XML');
  return doc as Document;
}

function is(node: Node | null | undefined, ns: string, local: string): node is Element {
  return (
    node?.nodeType === ELEMENT &&
    (node as Element).namespaceURI === ns &&
    (node as Element).localName === local
  );
}

/** Element children, in order. */
function elements(parent: Node): Element[] {
  const out: Element[] = [];
  for (let n = parent.firstChild; n; n = n.nextSibling) {
    if (n.nodeType === ELEMENT) out.push(n as Element);
  }
  return out;
}

function childrenNamed(parent: Node, ns: string, local: string): Element[] {
  return elements(parent).filter((e) => is(e, ns, local));
}

/** The one child of that name; refuses a second one, and a missing one when required. */
function single(parent: Node, ns: string, local: string, required: true): Element;
function single(parent: Node, ns: string, local: string, required?: false): Element | undefined;
function single(parent: Node, ns: string, local: string, required = false) {
  const found = childrenNamed(parent, ns, local);
  if (found.length > 1) refuse('wrapped', `More than one ${local}`);
  if (required && found.length === 0) refuse('malformed', `${local} is missing`);
  return found[0];
}

/** Every node below (and including) a node, without recursion. */
function* descendants(root: Node): Generator<Node> {
  const stack: [Node, number][] = [[root, 0]];
  while (stack.length > 0) {
    const [node, depth] = stack.pop() as [Node, number];
    // SAML nests a dozen levels; far deeper documents only serve to exhaust a recursive reader.
    if (depth > MAX_DEPTH) refuse('malformed', 'Nested too deeply');
    yield node;
    for (let n = node.lastChild; n; n = n.previousSibling) stack.push([n, depth + 1]);
  }
}

/** Text of an element that holds only text (no child elements). */
function textOf(element: Element): string {
  if (elements(element).length > 0) refuse('malformed', `${element.localName} holds elements`);
  return (element.textContent ?? '').trim();
}

const attr = (element: Element, name: string): string | null =>
  element.hasAttribute(name) ? element.getAttribute(name) : null;

const ID_NAMES = new Set(['ID', 'Id', 'id']);

const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

function instant(element: Element, name: string): Date | null {
  const value = attr(element, name);
  if (value === null) return null;
  const at = INSTANT.test(value) ? Date.parse(value) : Number.NaN;
  if (Number.isNaN(at)) refuse('malformed', `${name} is not a time`, true);
  return new Date(at);
}

export function escapeXml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

// ---- Certificates ----

const PEM_BLOCK = /-----BEGIN CERTIFICATE-----([\s\S]*?)-----END CERTIFICATE-----/g;

function pemOf(der: Buffer): string {
  const lines = der.toString('base64').match(/.{1,64}/g) ?? [];
  return `-----BEGIN CERTIFICATE-----\n${lines.join('\n')}\n-----END CERTIFICATE-----`;
}

/**
 * Certificates as PEM, from PEM blocks or bare base64 (as metadata holds them). Throws on
 * anything that is not an X.509 certificate.
 */
export function readCertificates(inputs: readonly string[]): string[] {
  const out: string[] = [];
  for (const input of inputs) {
    const blocks = [...input.matchAll(PEM_BLOCK)].map((m) => m[1] ?? '');
    for (const body of blocks.length > 0 ? blocks : [input]) {
      const base64 = body.replace(/\s+/g, '');
      if (!/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) throw new Error('Not a certificate');
      const der = Buffer.from(base64, 'base64');
      new X509Certificate(der); // throws when it is not one
      const pem = pemOf(der);
      if (!out.includes(pem)) out.push(pem);
    }
  }
  return out;
}

export interface CertificateSummary {
  /** SHA-256 fingerprint, colon-separated hex. */
  fingerprint: string;
  subject: string;
  notAfter: string;
}

export function certificateSummary(pem: string): CertificateSummary {
  const cert = new X509Certificate(pem);
  return {
    fingerprint: cert.fingerprint256,
    subject: cert.subject.replaceAll('\n', ', '),
    notAfter: new Date(cert.validTo).toISOString(),
  };
}

// ---- Responses ----

export interface SamlExpectations {
  /** The identity provider's signing certificates (PEM); nothing else is trusted. */
  certificates: readonly string[];
  /** The identity provider's entity ID: the Issuer it must use. */
  idpEntityId: string;
  /** Our entity ID for this provider: the audience. */
  spEntityId: string;
  /** Where the response must be addressed (Destination and Recipient). */
  acsUrl: string;
  now?: Date;
}

export interface SamlAssertion {
  assertionId: string;
  /** The request this answers (signed, from the bearer confirmation); null when unsolicited. */
  inResponseTo: string | null;
  nameId: string;
  nameIdFormat: string | null;
  /** Attribute values by Name, and by FriendlyName where it differs. */
  attributes: Map<string, string[]>;
  sessionIndex: string | null;
  /** Until when the assertion could be accepted: its ID must be remembered that long. */
  replayUntil: Date;
}

/** The base64 SAMLResponse of an HTTP-POST binding, decoded. */
export function decodeSamlResponse(encoded: string): string {
  const compact = encoded.replace(/\s+/g, '');
  if (compact.length > Math.ceil((SAML_MAX_RESPONSE_BYTES * 4) / 3) + 4) {
    refuse('malformed', 'The response is too large');
  }
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(compact)) refuse('malformed', 'Not base64');
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(compact, 'base64'));
  } catch {
    return refuse('malformed', 'Not UTF-8');
  }
}

/**
 * Structure every response must have before any signature is looked at, and again for the
 * signed copy of a Response: the root Response with exactly one Assertion child and nothing that
 * could hide another one.
 */
function checkStructure(root: Element): { assertion: Element; signatures: Element[] } {
  if (!is(root, SAML_NS.protocol, 'Response')) refuse('malformed', 'Not a SAML Response');
  const assertions: Element[] = [];
  const signatures: Element[] = [];
  const ids = new Set<string>();
  for (const node of descendants(root)) {
    switch (node.nodeType) {
      case COMMENT:
      case PROCESSING_INSTRUCTION:
      case CDATA:
      case ENTITY_REFERENCE:
      case DOCUMENT_TYPE:
        refuse('malformed', 'Comments, processing instructions and CDATA are refused');
        break;
      case ELEMENT: {
        const element = node as Element;
        if (element.localName === 'EncryptedAssertion') {
          refuse('encrypted', 'Encrypted assertions are not supported');
        }
        if (element.localName === 'Assertion') assertions.push(element);
        if (element.localName === 'Response' && element !== root) {
          refuse('wrapped', 'A Response inside the Response');
        }
        if (is(element, SAML_NS.dsig, 'Signature')) signatures.push(element);
        // As xml-crypto finds a referenced element: any attribute named ID, Id or id, in any
        // namespace.
        for (const attribute of Array.from(element.attributes)) {
          if (!ID_NAMES.has(attribute.localName ?? attribute.name)) continue;
          if (ids.has(attribute.value)) refuse('wrapped', 'Duplicate ID');
          ids.add(attribute.value);
        }
        break;
      }
    }
  }
  if (assertions.length === 0) refuse('subject', 'No assertion');
  if (assertions.length > 1) refuse('wrapped', 'More than one assertion');
  const assertion = assertions[0] as Element;
  if (!is(assertion, SAML_NS.assertion, 'Assertion') || assertion.parentNode !== root) {
    refuse('wrapped', 'The assertion is not a child of the Response');
  }
  for (const signature of signatures) {
    if (signature.parentNode !== root && signature.parentNode !== assertion) {
      refuse('wrapped', 'A signature outside the Response and the Assertion');
    }
  }
  single(root, SAML_NS.dsig, 'Signature');
  single(assertion, SAML_NS.dsig, 'Signature');
  return { assertion, signatures };
}

/** The algorithms and the single reference of an enveloped signature, checked before use. */
function checkSignatureShape(signature: Element, signed: Element): void {
  const id = attr(signed, 'ID');
  if (!id) refuse('malformed', 'The signed element has no ID');
  for (const child of elements(signature)) {
    if (!['SignedInfo', 'SignatureValue', 'KeyInfo'].includes(child.localName ?? '')) {
      refuse('wrapped', `Unexpected ${child.localName} in a signature`);
    }
  }
  const info = single(signature, SAML_NS.dsig, 'SignedInfo', true);
  single(signature, SAML_NS.dsig, 'SignatureValue', true);
  const c14n = single(info, SAML_NS.dsig, 'CanonicalizationMethod', true);
  const method = single(info, SAML_NS.dsig, 'SignatureMethod', true);
  if (!CANONICALIZATIONS.has(attr(c14n, 'Algorithm') ?? '')) {
    refuse('bad_signature', 'Canonicalization not accepted');
  }
  if (!SIGNATURE_ALGORITHMS.has(attr(method, 'Algorithm') ?? '')) {
    refuse('bad_signature', 'Signature algorithm not accepted');
  }
  const references = childrenNamed(info, SAML_NS.dsig, 'Reference');
  if (references.length !== 1) refuse('wrapped', 'A signature must have exactly one reference');
  const reference = references[0] as Element;
  if (attr(reference, 'URI') !== `#${id}`) {
    refuse('wrapped', 'The signature does not reference the element it is in');
  }
  const transforms = single(reference, SAML_NS.dsig, 'Transforms');
  for (const transform of transforms ? elements(transforms) : []) {
    if (
      !is(transform, SAML_NS.dsig, 'Transform') ||
      !TRANSFORMS.has(attr(transform, 'Algorithm') ?? '')
    ) {
      refuse('bad_signature', 'Transform not accepted');
    }
  }
  const digest = single(reference, SAML_NS.dsig, 'DigestMethod', true);
  if (!DIGEST_ALGORITHMS.has(attr(digest, 'Algorithm') ?? '')) {
    refuse('bad_signature', 'Digest algorithm not accepted');
  }
}

/**
 * Verifies an enveloped signature against the trusted keys and returns the element it covers,
 * re-parsed from the canonical bytes the signature covers.
 */
function verifiedCopy(
  xml: string,
  signature: Element,
  signed: Element,
  keys: readonly X509Certificate[],
): Element {
  checkSignatureShape(signature, signed);
  for (const key of keys) {
    const verifier = new SignedXml({ publicCert: key.publicKey, getCertFromKeyInfo: () => null });
    let references: string[] = [];
    try {
      verifier.loadSignature(signature);
      if (!verifier.checkSignature(xml)) continue;
      references = verifier.getSignedReferences();
    } catch {
      continue;
    }
    if (references.length !== 1) continue;
    const copy = parseXml(references[0] as string).documentElement as Element;
    if (
      copy.namespaceURI !== signed.namespaceURI ||
      copy.localName !== signed.localName ||
      attr(copy, 'ID') !== attr(signed, 'ID')
    ) {
      refuse('wrapped', 'The signed content is not the element in use');
    }
    return copy;
  }
  return refuse('bad_signature', 'No trusted certificate verifies the signature');
}

function statusOf(response: Element): string | null {
  const status = single(response, SAML_NS.protocol, 'Status');
  const code = status ? single(status, SAML_NS.protocol, 'StatusCode') : undefined;
  return code ? attr(code, 'Value') : null;
}

/**
 * Verifies a decoded SAML response for one provider and returns its assertion. Throws
 * SamlError; the caller checks InResponseTo against its own requests and the assertion ID
 * against the replay cache.
 */
export function verifySamlResponse(xml: string, expected: SamlExpectations): SamlAssertion {
  if (Buffer.byteLength(xml) > SAML_MAX_RESPONSE_BYTES) refuse('malformed', 'Too large');
  const doc = parseXml(xml);
  const root = doc.documentElement as Element;
  // Outside the Response only the XML declaration and white space.
  for (let n = doc.firstChild; n; n = n.nextSibling) {
    const declaration =
      n === doc.firstChild && n.nodeType === PROCESSING_INSTRUCTION && n.nodeName === 'xml';
    const blank = n.nodeType === TEXT && (n.nodeValue ?? '').trim() === '';
    if (n !== root && !declaration && !blank) refuse('malformed', 'Content outside the Response');
  }
  if (!is(root, SAML_NS.protocol, 'Response')) refuse('malformed', 'Not a SAML Response');
  if (statusOf(root) !== STATUS_SUCCESS) refuse('status', 'The identity provider refused');
  const { assertion, signatures } = checkStructure(root);
  if (signatures.length === 0)
    refuse('unsigned', 'Neither the response nor the assertion is signed');

  const keys = expected.certificates.flatMap((pem) => {
    try {
      return [new X509Certificate(pem)];
    } catch {
      return [];
    }
  });
  if (keys.length === 0) refuse('bad_signature', 'The provider has no usable certificate');
  const responseSignature = signatures.find((s) => s.parentNode === root);
  const assertionSignature = signatures.find((s) => s.parentNode === assertion);
  // Every signature present must verify; one that does not is never ignored.
  const signedResponse = responseSignature
    ? verifiedCopy(xml, responseSignature, root, keys)
    : null;
  const signedAssertion = assertionSignature
    ? verifiedCopy(xml, assertionSignature, assertion, keys)
    : null;

  // Only signed bytes from here on.
  let use: Element;
  if (signedAssertion) {
    use = signedAssertion;
  } else {
    const inner = checkStructure(signedResponse as Element);
    use = inner.assertion;
  }
  // The Response's own fields come from its signed copy when it is signed. Unsigned, they can
  // only refuse (Destination, Issuer and InResponseTo must agree), never vouch for anything.
  const envelope = signedResponse ?? root;
  return readAssertion(use, envelope, signedResponse !== null, expected);
}

interface Confirmation {
  inResponseTo: string | null;
  notOnOrAfter: Date;
}

/** One bearer confirmation checked: what it confirms, or why it does not. */
function checkConfirmation(
  confirmation: Element,
  expected: SamlExpectations,
  envelopeInResponseTo: string | null,
  now: number,
): Confirmation | [SamlFailure, string] {
  const data = single(confirmation, SAML_NS.assertion, 'SubjectConfirmationData');
  if (!data) return ['subject', 'The bearer confirmation has no data'];
  if (attr(data, 'Recipient') !== expected.acsUrl) return ['recipient', 'Another recipient'];
  const until = instant(data, 'NotOnOrAfter');
  if (!until) return ['subject', 'The bearer confirmation has no NotOnOrAfter'];
  if (now >= until.getTime() + SAML_CLOCK_SKEW_MS) return ['expired', 'Confirmation expired'];
  const from = instant(data, 'NotBefore');
  if (from && now < from.getTime() - SAML_CLOCK_SKEW_MS) return ['not_yet_valid', 'Too early'];
  const inResponseTo = attr(data, 'InResponseTo');
  if (envelopeInResponseTo !== null && envelopeInResponseTo !== inResponseTo) {
    return ['in_response_to', 'The response and the assertion answer different requests'];
  }
  return { inResponseTo, notOnOrAfter: until };
}

/** Values of an attribute that are plain text; structured values are left out. */
function attributeValues(attribute: Element): string[] {
  return childrenNamed(attribute, SAML_NS.assertion, 'AttributeValue')
    .filter((value) => elements(value).length === 0)
    .map((value) => (value.textContent ?? '').trim())
    .filter((value) => value !== '');
}

function readAssertion(
  assertion: Element,
  envelope: Element,
  envelopeSigned: boolean,
  expected: SamlExpectations,
): SamlAssertion {
  // From here the provider's signature has verified: refusals are on its word.
  function fail(reason: SamlFailure, message: string): never {
    refuse(reason, message, true);
  }
  const now = (expected.now ?? new Date()).getTime();
  const skew = SAML_CLOCK_SKEW_MS;

  // Issuer: the Response's, when it names one, and the assertion's, which is required.
  const envelopeIssuer = single(envelope, SAML_NS.assertion, 'Issuer');
  if (envelopeIssuer && textOf(envelopeIssuer) !== expected.idpEntityId) {
    fail('issuer', 'The response comes from another issuer');
  }
  const issuer = single(assertion, SAML_NS.assertion, 'Issuer', true);
  if (textOf(issuer) !== expected.idpEntityId) fail('issuer', 'Another issuer');
  if (attr(assertion, 'Version') !== '2.0') fail('malformed', 'Not a SAML 2.0 assertion');
  const assertionId = attr(assertion, 'ID') ?? '';
  if (!assertionId) fail('malformed', 'The assertion has no ID');
  const issued = instant(assertion, 'IssueInstant');
  if (!issued) fail('malformed', 'The assertion has no IssueInstant');
  if (issued.getTime() > now + skew) fail('not_yet_valid', 'Issued in the future');

  // Destination: required on a signed Response, and when present it must be us.
  const destination = attr(envelope, 'Destination');
  if (envelopeSigned && destination === null) fail('destination', 'No destination');
  if (destination !== null && destination !== expected.acsUrl) {
    fail('destination', 'The response is addressed elsewhere');
  }

  // Subject and its bearer confirmation (recipient, time, request).
  const subject = single(assertion, SAML_NS.assertion, 'Subject', true);
  if (
    single(subject, SAML_NS.assertion, 'EncryptedID') ||
    single(subject, SAML_NS.assertion, 'BaseID')
  ) {
    fail('subject', 'Only a plain NameID identifies the person');
  }
  const nameIdElement = single(subject, SAML_NS.assertion, 'NameID', true);
  const nameId = textOf(nameIdElement);
  // biome-ignore lint/suspicious/noControlCharactersInRegex: refusing control characters
  if (!nameId || /[\u0000-\u001f\u007f]/.test(nameId)) fail('subject', 'Unusable NameID');
  const envelopeInResponseTo = attr(envelope, 'InResponseTo');
  let confirmation: Confirmation | null = null;
  let problem: [SamlFailure, string] = ['subject', 'No bearer confirmation'];
  for (const candidate of childrenNamed(subject, SAML_NS.assertion, 'SubjectConfirmation')) {
    if (attr(candidate, 'Method') !== BEARER) continue;
    const checked = checkConfirmation(candidate, expected, envelopeInResponseTo, now);
    if (!Array.isArray(checked)) {
      confirmation = checked;
      break;
    }
    if (problem[1] === 'No bearer confirmation') problem = checked;
  }
  if (!confirmation) fail(problem[0], problem[1]);

  // Conditions: time window and audience, which must name us in every restriction.
  const conditions = single(assertion, SAML_NS.assertion, 'Conditions');
  if (!conditions) fail('audience', 'The assertion names no audience');
  const notBefore = instant(conditions, 'NotBefore');
  const notOnOrAfter = instant(conditions, 'NotOnOrAfter');
  if (notBefore && now < notBefore.getTime() - skew) fail('not_yet_valid', 'Not yet valid');
  if (notOnOrAfter && now >= notOnOrAfter.getTime() + skew) fail('expired', 'Expired');
  let restrictions = 0;
  for (const condition of elements(conditions)) {
    const kind = condition.localName;
    if (is(condition, SAML_NS.assertion, 'AudienceRestriction')) {
      restrictions++;
      const audiences = childrenNamed(condition, SAML_NS.assertion, 'Audience').map(textOf);
      if (!audiences.includes(expected.spEntityId)) fail('audience', 'Meant for someone else');
    } else if (
      !is(condition, SAML_NS.assertion, 'OneTimeUse') &&
      !is(condition, SAML_NS.assertion, 'ProxyRestriction')
    ) {
      // A condition we do not understand makes the assertion invalid (SAML core 2.5.1.5).
      fail('malformed', `Unknown condition ${kind}`);
    }
  }
  if (restrictions === 0) fail('audience', 'The assertion names no audience');

  // An authentication statement: this is a sign-in, not just attributes.
  const statement = childrenNamed(assertion, SAML_NS.assertion, 'AuthnStatement')[0];
  if (!statement) fail('subject', 'No authentication statement');
  const sessionUntil = instant(statement, 'SessionNotOnOrAfter');
  if (sessionUntil && now >= sessionUntil.getTime() + skew) fail('expired', 'Session over');

  const attributes = new Map<string, string[]>();
  for (const block of childrenNamed(assertion, SAML_NS.assertion, 'AttributeStatement')) {
    for (const attribute of childrenNamed(block, SAML_NS.assertion, 'Attribute')) {
      const values = attributeValues(attribute);
      const names = new Set([attr(attribute, 'Name'), attr(attribute, 'FriendlyName')]);
      for (const key of names) {
        if (key) attributes.set(key, [...(attributes.get(key) ?? []), ...values]);
      }
    }
  }

  const latest = Math.max(confirmation.notOnOrAfter.getTime(), notOnOrAfter?.getTime() ?? 0);
  return {
    assertionId,
    inResponseTo: confirmation.inResponseTo,
    nameId,
    nameIdFormat: attr(nameIdElement, 'Format'),
    attributes,
    sessionIndex: attr(statement, 'SessionIndex'),
    replayUntil: new Date(latest + skew),
  };
}

// ---- Requests ----

/** An ID for a request: an NCName, unguessable. */
export function newRequestId(): string {
  return `_${randomBytes(20).toString('hex')}`;
}

export interface AuthnRequestInput {
  id: string;
  ssoUrl: string;
  spEntityId: string;
  acsUrl: string;
  now?: Date;
  relayState?: string;
}

export function authnRequestXml(input: AuthnRequestInput): string {
  const at = (input.now ?? new Date()).toISOString().replace(/\.\d{3}Z$/, 'Z');
  return (
    `<samlp:AuthnRequest xmlns:samlp="${SAML_NS.protocol}" xmlns:saml="${SAML_NS.assertion}"` +
    ` ID="${escapeXml(input.id)}" Version="2.0" IssueInstant="${at}"` +
    ` Destination="${escapeXml(input.ssoUrl)}"` +
    ` AssertionConsumerServiceURL="${escapeXml(input.acsUrl)}"` +
    ` ProtocolBinding="${SAML_BINDING.post}">` +
    `<saml:Issuer>${escapeXml(input.spEntityId)}</saml:Issuer>` +
    `<samlp:NameIDPolicy Format="${NAME_ID_FORMAT.unspecified}" AllowCreate="true"/>` +
    '</samlp:AuthnRequest>'
  );
}

/** The identity provider address that carries an AuthnRequest (HTTP-Redirect binding). */
export function authnRequestUrl(input: AuthnRequestInput): string {
  const request = deflateRawSync(Buffer.from(authnRequestXml(input))).toString('base64');
  const url = new URL(input.ssoUrl);
  url.searchParams.append('SAMLRequest', request);
  if (input.relayState) url.searchParams.append('RelayState', input.relayState);
  return url.toString();
}

// ---- Metadata ----

/** What Taskmoor publishes for one provider: who it is and where responses go. */
export function serviceProviderMetadata(input: { entityId: string; acsUrl: string }): string {
  return (
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    `<md:EntityDescriptor xmlns:md="${SAML_NS.metadata}" entityID="${escapeXml(input.entityId)}">` +
    `<md:SPSSODescriptor AuthnRequestsSigned="false" WantAssertionsSigned="true"` +
    ` protocolSupportEnumeration="${SAML_NS.protocol}">` +
    `<md:NameIDFormat>${NAME_ID_FORMAT.persistent}</md:NameIDFormat>` +
    `<md:NameIDFormat>${NAME_ID_FORMAT.email}</md:NameIDFormat>` +
    `<md:NameIDFormat>${NAME_ID_FORMAT.unspecified}</md:NameIDFormat>` +
    `<md:AssertionConsumerService Binding="${SAML_BINDING.post}"` +
    ` Location="${escapeXml(input.acsUrl)}" index="0" isDefault="true"/>` +
    '</md:SPSSODescriptor></md:EntityDescriptor>\n'
  );
}

export interface IdpMetadata {
  entityId: string;
  ssoUrl: string;
  certificates: string[];
}

export class MetadataError extends Error {}

/**
 * Reads an identity provider's metadata (an EntityDescriptor, or an EntitiesDescriptor with one
 * identity provider): its entity ID, the HTTP-Redirect sign-in address and the signing
 * certificates. An administrator supplies it, so its own signature is not required.
 */
export function parseIdpMetadata(xml: string): IdpMetadata {
  let doc: Document;
  try {
    doc = parseXml(xml);
  } catch {
    throw new MetadataError('The metadata is not well-formed XML');
  }
  const root = doc.documentElement as Element;
  const entities = is(root, SAML_NS.metadata, 'EntitiesDescriptor')
    ? [...descendants(root)].filter((n): n is Element =>
        is(n, SAML_NS.metadata, 'EntityDescriptor'),
      )
    : [root];
  const idps = entities.flatMap((entity) => {
    if (!is(entity, SAML_NS.metadata, 'EntityDescriptor')) return [];
    const descriptor = childrenNamed(entity, SAML_NS.metadata, 'IDPSSODescriptor').find((d) =>
      (attr(d, 'protocolSupportEnumeration') ?? '').split(/\s+/).includes(SAML_NS.protocol),
    );
    return descriptor ? [{ entity, descriptor }] : [];
  });
  if (idps.length === 0) throw new MetadataError('No SAML 2.0 identity provider in the metadata');
  if (idps.length > 1) throw new MetadataError('The metadata describes several identity providers');
  const { entity, descriptor } = idps[0] as { entity: Element; descriptor: Element };
  const entityId = attr(entity, 'entityID')?.trim();
  if (!entityId) throw new MetadataError('The metadata has no entityID');
  const sso = childrenNamed(descriptor, SAML_NS.metadata, 'SingleSignOnService').find(
    (s) => attr(s, 'Binding') === SAML_BINDING.redirect,
  );
  const ssoUrl = sso ? attr(sso, 'Location')?.trim() : undefined;
  if (!ssoUrl) throw new MetadataError('The identity provider offers no HTTP-Redirect sign-in');
  const raw: string[] = [];
  for (const key of childrenNamed(descriptor, SAML_NS.metadata, 'KeyDescriptor')) {
    const use = attr(key, 'use');
    if (use !== null && use !== 'signing') continue;
    for (const node of descendants(key)) {
      if (is(node, SAML_NS.dsig, 'X509Certificate')) raw.push(node.textContent ?? '');
    }
  }
  let certificates: string[];
  try {
    certificates = readCertificates(raw);
  } catch {
    throw new MetadataError('A signing certificate in the metadata cannot be read');
  }
  if (certificates.length === 0) throw new MetadataError('The metadata has no signing certificate');
  return { entityId, ssoUrl, certificates };
}
