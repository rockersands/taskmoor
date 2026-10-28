import { randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { inflateRawSync } from 'node:zlib';
import { DOMParser } from '@xmldom/xmldom';
import { SignedXml } from 'xml-crypto';
import { escapeXml, NAME_ID_FORMAT, SAML_BINDING, SAML_NS } from '../sso/saml';
import { selfSignedCertificate, type TestCertificate } from './x509';

/**
 * A fake SAML 2.0 identity provider for tests (M1-081): it reads AuthnRequests from the
 * HTTP-Redirect binding and writes responses as a real provider would (signed assertion and/or
 * response, RSA-SHA-256, exclusive canonicalization), with a key and certificate made per
 * instance. Every part of a response can be bent, so tests can also build attacks.
 */
export const EXC_C14N = 'http://www.w3.org/2001/10/xml-exc-c14n#';
export const RSA_SHA256 = 'http://www.w3.org/2001/04/xmldsig-more#rsa-sha256';
export const RSA_SHA1 = 'http://www.w3.org/2000/09/xmldsig#rsa-sha1';
export const SHA256 = 'http://www.w3.org/2001/04/xmlenc#sha256';
export const SHA1 = 'http://www.w3.org/2000/09/xmldsig#sha1';
const ENVELOPED = 'http://www.w3.org/2000/09/xmldsig#enveloped-signature';

export interface SamlPerson {
  nameId: string;
  nameIdFormat?: string;
  /** Attribute values by name, sent with the Basic name format. */
  attributes?: Record<string, string[]>;
}

export interface SamlResponseOptions {
  person: SamlPerson;
  /** The service provider's ACS address: Destination and Recipient. */
  acsUrl: string;
  /** The service provider's entity ID: the audience. */
  audience: string;
  /** The request answered; null or absent for an IdP-initiated response. */
  inResponseTo?: string | null;
  /** What carries a signature (default: the assertion). */
  sign?: 'assertion' | 'response' | 'both' | 'none';
  now?: Date;
  /** How long the assertion stays valid, in seconds (default 300). */
  lifetimeSeconds?: number;
  issuer?: string;
  /** null leaves the attribute out. */
  destination?: string | null;
  recipient?: string;
  status?: string;
  signatureAlgorithm?: string;
  digestAlgorithm?: string;
  canonicalization?: string;
  /** Sign with another key, as an attacker would. */
  key?: TestCertificate;
  assertionId?: string;
  responseId?: string;
}

/** A SAML request read back from the redirect address. */
export interface ReceivedRequest {
  id: string;
  issuer: string;
  acsUrl: string | null;
  destination: string | null;
  protocolBinding: string | null;
  relayState: string | null;
  xml: string;
}

const instant = (at: Date) => at.toISOString().replace(/\.\d{3}Z$/, 'Z');
export const samlId = () => `_${randomBytes(16).toString('hex')}`;

/** Signs the element with that ID; the signature goes right after its Issuer. */
export function signElement(
  xml: string,
  id: string,
  key: TestCertificate,
  algorithms: { signature?: string; digest?: string; canonicalization?: string } = {},
): string {
  const c14n = algorithms.canonicalization ?? EXC_C14N;
  const signer = new SignedXml({
    privateKey: key.privateKeyPem,
    publicCert: key.certificate,
    signatureAlgorithm: algorithms.signature ?? RSA_SHA256,
    canonicalizationAlgorithm: c14n,
  });
  signer.addReference({
    xpath: `//*[@ID='${id}']`,
    transforms: [ENVELOPED, c14n],
    digestAlgorithm: algorithms.digest ?? SHA256,
  });
  signer.computeSignature(xml, {
    prefix: 'ds',
    location: {
      reference: `//*[@ID='${id}']/*[local-name(.)='Issuer']`,
      action: 'after',
    },
  });
  return signer.getSignedXml();
}

export class FakeSamlIdp {
  entityId: string;
  ssoUrl: string;
  readonly signing: TestCertificate;
  /** Who the HTTP sign-in page (`start`) signs in; null refuses everyone. */
  person: SamlPerson | null = null;
  private server: Server | undefined;

  constructor(options: { entityId?: string; ssoUrl?: string } = {}) {
    this.entityId = options.entityId ?? 'https://idp.saml.test/metadata';
    this.ssoUrl = options.ssoUrl ?? 'https://idp.saml.test/sso';
    this.signing = selfSignedCertificate('Fake SAML IdP');
  }

  /**
   * Serves the provider over HTTP on loopback, for browser tests: its metadata at /metadata,
   * and at /sso a page that answers the AuthnRequest for `person` and posts the response to
   * the service provider, as an identity provider's HTTP-POST binding page does. The entity ID
   * and sign-in address become this server's.
   */
  async start(port = 0): Promise<string> {
    this.server = createServer((req, res) => {
      try {
        const url = new URL(req.url ?? '/', this.ssoUrl);
        if (url.pathname === '/metadata') {
          res.writeHead(200, { 'content-type': 'application/samlmetadata+xml' });
          res.end(this.metadata());
          return;
        }
        if (url.pathname === '/sso' && this.person) {
          const request = this.readRequest(url.toString());
          const response = this.post({
            person: this.person,
            acsUrl: request.acsUrl ?? '',
            audience: request.issuer,
            inResponseTo: request.id,
          });
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
          res.end(postForm(request.acsUrl ?? '', response, request.relayState));
          return;
        }
        res.writeHead(404, { 'content-type': 'text/plain' });
        res.end('not found');
      } catch (error) {
        res.writeHead(400, { 'content-type': 'text/plain' });
        res.end(String(error));
      }
    });
    await new Promise<void>((resolve) => this.server?.listen(port, '127.0.0.1', resolve));
    const address = this.server.address();
    const base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
    this.entityId = `${base}/metadata`;
    this.ssoUrl = `${base}/sso`;
    return base;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) =>
      this.server ? this.server.close(() => resolve()) : resolve(),
    );
  }

  /** The provider's metadata, as an administrator would paste it. */
  metadata(): string {
    const body = this.signing.certificate.replace(/-----[A-Z ]+-----|\s+/g, '');
    return (
      '<?xml version="1.0" encoding="UTF-8"?>\n' +
      `<md:EntityDescriptor xmlns:md="${SAML_NS.metadata}" xmlns:ds="${SAML_NS.dsig}" entityID="${escapeXml(this.entityId)}">\n` +
      '  <!-- written by the fake identity provider -->\n' +
      `  <md:IDPSSODescriptor protocolSupportEnumeration="${SAML_NS.protocol}" WantAuthnRequestsSigned="false">\n` +
      '    <md:KeyDescriptor use="signing"><ds:KeyInfo><ds:X509Data>\n' +
      `      <ds:X509Certificate>${body}</ds:X509Certificate>\n` +
      '    </ds:X509Data></ds:KeyInfo></md:KeyDescriptor>\n' +
      `    <md:NameIDFormat>${NAME_ID_FORMAT.email}</md:NameIDFormat>\n` +
      `    <md:SingleSignOnService Binding="${SAML_BINDING.post}" Location="${escapeXml(this.ssoUrl)}/post"/>\n` +
      `    <md:SingleSignOnService Binding="${SAML_BINDING.redirect}" Location="${escapeXml(this.ssoUrl)}"/>\n` +
      '  </md:IDPSSODescriptor>\n' +
      '</md:EntityDescriptor>\n'
    );
  }

  /** Reads the AuthnRequest a service provider sent the browser to (HTTP-Redirect). */
  readRequest(location: string): ReceivedRequest {
    const url = new URL(location);
    const encoded = url.searchParams.get('SAMLRequest');
    if (!encoded) throw new Error('No SAMLRequest');
    const xml = inflateRawSync(Buffer.from(encoded, 'base64')).toString('utf8');
    const request = new DOMParser().parseFromString(xml, 'text/xml').documentElement;
    if (request?.localName !== 'AuthnRequest') throw new Error('Not an AuthnRequest');
    const issuer = request.getElementsByTagNameNS(SAML_NS.assertion, 'Issuer')[0];
    return {
      id: request.getAttribute('ID') ?? '',
      issuer: issuer?.textContent ?? '',
      acsUrl: request.getAttribute('AssertionConsumerServiceURL'),
      destination: request.getAttribute('Destination'),
      protocolBinding: request.getAttribute('ProtocolBinding'),
      relayState: url.searchParams.get('RelayState'),
      xml,
    };
  }

  /** The assertion alone, unsigned. */
  assertionXml(options: SamlResponseOptions, id: string): string {
    const now = options.now ?? new Date();
    const until = new Date(now.getTime() + (options.lifetimeSeconds ?? 300) * 1000);
    const from = new Date(now.getTime() - 30 * 1000);
    const inResponseTo = options.inResponseTo
      ? ` InResponseTo="${escapeXml(options.inResponseTo)}"`
      : '';
    const attributes = Object.entries(options.person.attributes ?? {});
    const statement =
      attributes.length === 0
        ? ''
        : `<saml:AttributeStatement>${attributes
            .map(
              ([name, values]) =>
                `<saml:Attribute Name="${escapeXml(name)}" NameFormat="urn:oasis:names:tc:SAML:2.0:attrname-format:basic">${values
                  .map(
                    (v) =>
                      `<saml:AttributeValue xmlns:xs="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:type="xs:string">${escapeXml(v)}</saml:AttributeValue>`,
                  )
                  .join('')}</saml:Attribute>`,
            )
            .join('')}</saml:AttributeStatement>`;
    return (
      `<saml:Assertion xmlns:saml="${SAML_NS.assertion}" ID="${id}" Version="2.0" IssueInstant="${instant(now)}">` +
      `<saml:Issuer>${escapeXml(options.issuer ?? this.entityId)}</saml:Issuer>` +
      '<saml:Subject>' +
      `<saml:NameID Format="${escapeXml(options.person.nameIdFormat ?? NAME_ID_FORMAT.email)}">${escapeXml(options.person.nameId)}</saml:NameID>` +
      '<saml:SubjectConfirmation Method="urn:oasis:names:tc:SAML:2.0:cm:bearer">' +
      `<saml:SubjectConfirmationData NotOnOrAfter="${instant(until)}" Recipient="${escapeXml(options.recipient ?? options.acsUrl)}"${inResponseTo}/>` +
      '</saml:SubjectConfirmation>' +
      '</saml:Subject>' +
      `<saml:Conditions NotBefore="${instant(from)}" NotOnOrAfter="${instant(until)}">` +
      `<saml:AudienceRestriction><saml:Audience>${escapeXml(options.audience)}</saml:Audience></saml:AudienceRestriction>` +
      '</saml:Conditions>' +
      `<saml:AuthnStatement AuthnInstant="${instant(now)}" SessionIndex="${samlId()}">` +
      '<saml:AuthnContext><saml:AuthnContextClassRef>urn:oasis:names:tc:SAML:2.0:ac:classes:PasswordProtectedTransport</saml:AuthnContextClassRef></saml:AuthnContext>' +
      '</saml:AuthnStatement>' +
      statement +
      '</saml:Assertion>'
    );
  }

  /** A whole response as XML, signed as asked. */
  response(options: SamlResponseOptions): string {
    const now = options.now ?? new Date();
    const key = options.key ?? this.signing;
    const sign = options.sign ?? 'assertion';
    const algorithms = {
      ...(options.signatureAlgorithm ? { signature: options.signatureAlgorithm } : {}),
      ...(options.digestAlgorithm ? { digest: options.digestAlgorithm } : {}),
      ...(options.canonicalization ? { canonicalization: options.canonicalization } : {}),
    };
    const assertionId = options.assertionId ?? samlId();
    const responseId = options.responseId ?? samlId();
    let assertion = this.assertionXml(options, assertionId);
    if (sign === 'assertion' || sign === 'both') {
      assertion = signElement(assertion, assertionId, key, algorithms);
    }
    const destination =
      options.destination === null
        ? ''
        : ` Destination="${escapeXml(options.destination ?? options.acsUrl)}"`;
    const inResponseTo = options.inResponseTo
      ? ` InResponseTo="${escapeXml(options.inResponseTo)}"`
      : '';
    let response =
      `<samlp:Response xmlns:samlp="${SAML_NS.protocol}" xmlns:saml="${SAML_NS.assertion}" ID="${responseId}" Version="2.0" IssueInstant="${instant(now)}"${destination}${inResponseTo}>` +
      `<saml:Issuer>${escapeXml(options.issuer ?? this.entityId)}</saml:Issuer>` +
      `<samlp:Status><samlp:StatusCode Value="${escapeXml(options.status ?? 'urn:oasis:names:tc:SAML:2.0:status:Success')}"/></samlp:Status>` +
      assertion +
      '</samlp:Response>';
    if (sign === 'response' || sign === 'both') {
      response = signElement(response, responseId, key, algorithms);
    }
    return response;
  }

  /** The base64 SAMLResponse an HTTP-POST form carries. */
  post(options: SamlResponseOptions): string {
    return encodeSamlResponse(this.response(options));
  }
}

/** The HTTP-POST binding page: a form the browser submits to the service provider at once. */
function postForm(action: string, samlResponse: string, relayState: string | null): string {
  const relay = relayState
    ? `<input type="hidden" name="RelayState" value="${escapeXml(relayState)}">`
    : '';
  return (
    '<!doctype html><html><head><title>Signing in</title></head>' +
    '<body onload="document.forms[0].submit()">' +
    `<form method="post" action="${escapeXml(action)}">` +
    `<input type="hidden" name="SAMLResponse" value="${escapeXml(samlResponse)}">${relay}` +
    '<noscript><button type="submit">Continue</button></noscript></form></body></html>'
  );
}

export function encodeSamlResponse(xml: string): string {
  return Buffer.from(xml, 'utf8').toString('base64');
}
