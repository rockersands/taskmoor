import { fc } from '@taskmoor/testkit/property';
import { DOMParser, XMLSerializer } from '@xmldom/xmldom';
import { describe, expect, it } from 'vitest';
import {
  EXC_C14N,
  encodeSamlResponse,
  FakeSamlIdp,
  RSA_SHA1,
  type SamlResponseOptions,
  SHA1,
  signElement,
} from '../testing/fake-saml-idp';
import { selfSignedCertificate } from '../testing/x509';
import {
  authnRequestUrl,
  certificateSummary,
  decodeSamlResponse,
  MetadataError,
  NAME_ID_FORMAT,
  parseIdpMetadata,
  readCertificates,
  SAML_BINDING,
  SAML_NS,
  SamlError,
  serviceProviderMetadata,
  verifySamlResponse,
} from './saml';

const SP = 'https://tracker.test/api/v1/auth/saml/1/metadata';
const ACS = 'https://tracker.test/api/v1/auth/saml/1/acs';
const idp = new FakeSamlIdp();
const attacker = selfSignedCertificate('Attacker');
const expected = {
  certificates: [idp.signing.certificate],
  idpEntityId: idp.entityId,
  spEntityId: SP,
  acsUrl: ACS,
};
const base: SamlResponseOptions = {
  person: {
    nameId: 'ada@corp.example',
    attributes: { email: ['ada@corp.example'], groups: ['eng', 'ops'] },
  },
  acsUrl: ACS,
  audience: SP,
  inResponseTo: '_request-1',
};

const verify = (xml: string, extra: Partial<typeof expected> & { now?: Date } = {}) =>
  verifySamlResponse(xml, { ...expected, ...extra });

/** The reason a response is refused, or 'accepted'. */
function outcome(xml: string, extra: Partial<typeof expected> & { now?: Date } = {}): string {
  try {
    verify(xml, extra);
    return 'accepted';
  } catch (error) {
    if (error instanceof SamlError) return error.reason;
    throw error;
  }
}

function vouched(xml: string): boolean {
  try {
    verify(xml);
  } catch (error) {
    if (error instanceof SamlError) return error.vouched;
  }
  throw new Error('accepted');
}

/** Edits a response's DOM and writes it back, as an attacker in the middle would. */
function tamper(xml: string, edit: (doc: Document) => void): string {
  const doc = new DOMParser().parseFromString(xml, 'text/xml');
  edit(doc);
  return new XMLSerializer().serializeToString(doc);
}

const byName = (doc: Document | Element, ns: string, local: string) =>
  Array.from(doc.getElementsByTagNameNS(ns, local));
const first = (doc: Document | Element, ns: string, local: string) => {
  const found = byName(doc, ns, local)[0];
  if (!found) throw new Error(`no ${local}`);
  return found;
};
const assertionOf = (doc: Document) => first(doc, SAML_NS.assertion, 'Assertion');
const signatureOf = (element: Element) => {
  const found = Array.from(element.childNodes).find(
    (n) => (n as Element).localName === 'Signature',
  ) as Element | undefined;
  if (!found) throw new Error('no signature');
  return found;
};

/** An unsigned assertion naming someone else, as an element of `doc`. */
function evilAssertion(doc: Document, id = '_evil'): Element {
  const xml = idp.assertionXml({ ...base, person: { nameId: 'admin@corp.example' } }, id);
  return doc.importNode(
    new DOMParser().parseFromString(xml, 'text/xml').documentElement as Element,
    true,
  ) as Element;
}

describe('SAML responses (M1-081)', () => {
  it('[IAM-002] accepts a signed assertion and reads the person from it', () => {
    const result = verify(idp.response(base));
    expect(result.nameId).toBe('ada@corp.example');
    expect(result.nameIdFormat).toBe(NAME_ID_FORMAT.email);
    expect(result.inResponseTo).toBe('_request-1');
    expect(result.attributes.get('email')).toEqual(['ada@corp.example']);
    expect(result.attributes.get('groups')).toEqual(['eng', 'ops']);
    expect(result.replayUntil.getTime()).toBeGreaterThan(Date.now() + 5 * 60 * 1000);
  });

  it('[IAM-002] accepts a signed response, or both signed, and an unsolicited response', () => {
    expect(verify(idp.response({ ...base, sign: 'response' })).nameId).toBe('ada@corp.example');
    expect(verify(idp.response({ ...base, sign: 'both' })).nameId).toBe('ada@corp.example');
    const unsolicited = verify(idp.response({ ...base, inResponseTo: null }));
    expect(unsolicited.inResponseTo).toBeNull();
  });

  it('[IAM-002] trusts any configured certificate, so keys can roll over', () => {
    const certificates = [attacker.certificate, idp.signing.certificate];
    expect(verify(idp.response(base), { certificates }).nameId).toBe('ada@corp.example');
  });

  it('[IAM-002] decodes the POST binding and refuses what is not base64 or too large', () => {
    const xml = idp.response(base);
    expect(decodeSamlResponse(encodeSamlResponse(xml))).toBe(xml);
    expect(() => decodeSamlResponse('not base64!')).toThrow(SamlError);
    expect(() => decodeSamlResponse('A'.repeat(400_000))).toThrow(SamlError);
  });

  describe('unsigned, wrongly signed or tampered responses are refused', () => {
    it('[IAM-002] refuses an unsigned response', () => {
      expect(outcome(idp.response({ ...base, sign: 'none' }))).toBe('unsigned');
    });

    it('[IAM-002] refuses a signature by a key the provider does not have, even with its certificate inside', () => {
      // The attacker's certificate travels in KeyInfo; only configured certificates count.
      expect(outcome(idp.response({ ...base, key: attacker }))).toBe('bad_signature');
      expect(outcome(idp.response({ ...base, key: attacker, sign: 'response' }))).toBe(
        'bad_signature',
      );
    });

    it('[IAM-002] refuses signed content changed after signing, white space included', () => {
      const signed = idp.response(base);
      const renamed = tamper(signed, (doc) => {
        const nameId = first(doc, SAML_NS.assertion, 'NameID');
        nameId.textContent = 'admin@corp.example';
      });
      expect(outcome(renamed)).toBe('bad_signature');
      const padded = tamper(signed, (doc) => {
        const nameId = first(doc, SAML_NS.assertion, 'NameID');
        nameId.textContent = ' ada@corp.example';
      });
      expect(outcome(padded)).toBe('bad_signature');
      const grouped = tamper(signed, (doc) => {
        const value = byName(doc, SAML_NS.assertion, 'AttributeValue')[1] as Element;
        value.textContent = 'admins';
      });
      expect(outcome(grouped)).toBe('bad_signature');
    });

    it('[IAM-002] refuses a bad response signature even when the assertion signature is good', () => {
      const both = idp.response({ ...base, sign: 'both' });
      const broken = tamper(both, (doc) => {
        doc.documentElement?.setAttribute('IssueInstant', '2001-01-01T00:00:00Z');
      });
      expect(outcome(broken)).toBe('bad_signature');
    });

    it('[IAM-002] refuses SHA-1 signatures and digests and comment-preserving canonicalization', () => {
      expect(outcome(idp.response({ ...base, signatureAlgorithm: RSA_SHA1 }))).toBe(
        'bad_signature',
      );
      expect(outcome(idp.response({ ...base, digestAlgorithm: SHA1 }))).toBe('bad_signature');
      expect(outcome(idp.response({ ...base, canonicalization: `${EXC_C14N}WithComments` }))).toBe(
        'bad_signature',
      );
    });

    it('[IAM-002] refuses comments, so a comment cannot cut a signed NameID short', () => {
      // The provider signed a name the attacker registered; the comment is not signed
      // content, so the signature still verifies, and a reader of the first text node would
      // see the victim's address.
      const signed = idp.response({
        ...base,
        person: { nameId: 'admin@corp.example.attacker.test' },
      });
      const injected = signed.replace(
        'admin@corp.example.attacker.test<',
        'admin@corp.example<!---->.attacker.test<',
      );
      expect(injected).not.toBe(signed);
      expect(outcome(injected)).toBe('malformed');
    });

    it('[IAM-002] refuses DTDs, entities, processing instructions and CDATA', () => {
      const signed = idp.response(base);
      expect(outcome(`<!DOCTYPE r [<!ENTITY e "x">]>${signed}`)).toBe('malformed');
      expect(outcome(signed.replace('<saml:Issuer>', '<?pi x?><saml:Issuer>'))).toBe('malformed');
      expect(outcome(`${signed}<!-- trailing -->`)).toBe('malformed');
      const cdata = signed.replace(
        '>ada@corp.example</saml:NameID>',
        '><![CDATA[ada@corp.example]]></saml:NameID>',
      );
      expect(outcome(cdata)).toBe('malformed');
      expect(outcome('<x/>')).toBe('malformed');
      const deep = signed.replace(
        '<saml:AttributeStatement>',
        `<saml:AttributeStatement>${'<a>'.repeat(5000)}${'</a>'.repeat(5000)}`,
      );
      expect(outcome(deep)).toBe('malformed');
      expect(outcome('not xml at all')).toBe('malformed');
    });

    it('[IAM-002] refuses encrypted assertions, which this provider does not read', () => {
      const signed = idp.response({ ...base, sign: 'response' });
      const encrypted = tamper(signed, (doc) => {
        const assertion = assertionOf(doc);
        const wrapper = doc.createElementNS(SAML_NS.assertion, 'saml:EncryptedAssertion');
        assertion.parentNode?.replaceChild(wrapper, assertion);
      });
      expect(outcome(encrypted)).toBe('encrypted');
    });

    it('[IAM-002] refuses a failure status', () => {
      const denied = idp.response({
        ...base,
        status: 'urn:oasis:names:tc:SAML:2.0:status:Requester',
      });
      expect(outcome(denied)).toBe('status');
    });
  });

  describe('signature wrapping (XSW) is refused', () => {
    const signedAssertion = idp.response(base);
    const signedResponse = idp.response({ ...base, sign: 'response' });

    it('[IAM-002] XSW1: a new Response with the signed one inside its signature', () => {
      const attack = tamper(signedResponse, (doc) => {
        const original = doc.documentElement as Element;
        const copy = original.cloneNode(true) as Element;
        original.setAttribute('ID', '_evil-response');
        original.replaceChild(evilAssertion(doc), assertionOf(doc));
        signatureOf(original).appendChild(copy);
      });
      expect(outcome(attack)).toBe('wrapped');
    });

    it('[IAM-002] XSW2: a new Response with the signed one beside its signature', () => {
      const attack = tamper(signedResponse, (doc) => {
        const original = doc.documentElement as Element;
        const copy = original.cloneNode(true) as Element;
        copy.removeChild(signatureOf(copy));
        original.setAttribute('ID', '_evil-response');
        original.replaceChild(evilAssertion(doc), assertionOf(doc));
        original.insertBefore(copy, signatureOf(original));
      });
      expect(outcome(attack)).toBe('wrapped');
    });

    it('[IAM-002] XSW3: an unsigned assertion before the signed one', () => {
      const attack = tamper(signedAssertion, (doc) => {
        const assertion = assertionOf(doc);
        assertion.parentNode?.insertBefore(evilAssertion(doc), assertion);
      });
      expect(outcome(attack)).toBe('wrapped');
    });

    it('[IAM-002] XSW4: an unsigned assertion wrapping the signed one', () => {
      const attack = tamper(signedAssertion, (doc) => {
        const assertion = assertionOf(doc);
        const evil = evilAssertion(doc);
        assertion.parentNode?.replaceChild(evil, assertion);
        evil.appendChild(assertion);
      });
      expect(outcome(attack)).toBe('wrapped');
    });

    it('[IAM-002] XSW5: the signature moved into an unsigned assertion, the signed one appended', () => {
      const attack = tamper(signedAssertion, (doc) => {
        const assertion = assertionOf(doc);
        const evil = evilAssertion(doc);
        const signature = signatureOf(assertion).cloneNode(true);
        evil.insertBefore(signature, evil.firstChild?.nextSibling ?? null);
        assertion.parentNode?.insertBefore(evil, assertion);
        assertion.removeChild(signatureOf(assertion));
      });
      expect(outcome(attack)).toBe('wrapped');
    });

    it('[IAM-002] XSW6: the signed assertion hidden inside the signature of an unsigned one', () => {
      const attack = tamper(signedAssertion, (doc) => {
        const assertion = assertionOf(doc);
        const evil = evilAssertion(doc);
        const signature = signatureOf(assertion).cloneNode(true) as Element;
        assertion.parentNode?.replaceChild(evil, assertion);
        evil.insertBefore(signature, evil.firstChild?.nextSibling ?? null);
        signature.appendChild(assertion);
      });
      expect(outcome(attack)).toBe('wrapped');
    });

    it('[IAM-002] XSW7: the signed assertion in Extensions, an unsigned one in its place', () => {
      const attack = tamper(signedAssertion, (doc) => {
        const response = doc.documentElement as Element;
        const assertion = assertionOf(doc);
        const extensions = doc.createElementNS(SAML_NS.protocol, 'samlp:Extensions');
        response.replaceChild(evilAssertion(doc), assertion);
        extensions.appendChild(assertion);
        response.insertBefore(extensions, response.firstChild?.nextSibling ?? null);
      });
      expect(outcome(attack)).toBe('wrapped');
    });

    it('[IAM-002] XSW8: an Object in the signature holding the signed assertion', () => {
      const attack = tamper(signedAssertion, (doc) => {
        const assertion = assertionOf(doc);
        const evil = evilAssertion(doc);
        const signature = signatureOf(assertion);
        const object = doc.createElementNS(SAML_NS.dsig, 'ds:Object');
        assertion.removeChild(signature);
        object.appendChild(assertion);
        signature.appendChild(object);
        evil.insertBefore(signature, evil.firstChild?.nextSibling ?? null);
        doc.documentElement?.appendChild(evil);
      });
      expect(outcome(attack)).toBe('wrapped');
    });

    it('[IAM-002] refuses an unsigned second assertion next to a signed response', () => {
      const attack = tamper(signedResponse, (doc) => {
        doc.documentElement?.appendChild(evilAssertion(doc));
      });
      expect(outcome(attack)).toBe('wrapped');
    });

    it('[IAM-002] refuses a signature whose reference points at another element', () => {
      // The Response's signature, moved into the (unsigned) assertion: it still verifies, but
      // covers the Response, not the assertion it now sits in.
      const attack = tamper(signedResponse, (doc) => {
        const response = doc.documentElement as Element;
        const signature = signatureOf(response);
        response.removeChild(signature);
        const assertion = assertionOf(doc);
        assertion.insertBefore(signature, assertion.firstChild?.nextSibling ?? null);
      });
      expect(outcome(attack)).toBe('wrapped');
    });

    it('[IAM-002] refuses duplicate IDs and signatures outside the Response and the Assertion', () => {
      const duplicate = tamper(signedResponse, (doc) => {
        const extensions = doc.createElementNS(SAML_NS.protocol, 'samlp:Extensions');
        extensions.setAttribute('ID', assertionOf(doc).getAttribute('ID') ?? '');
        doc.documentElement?.insertBefore(extensions, assertionOf(doc));
      });
      expect(outcome(duplicate)).toBe('wrapped');
      const namespaced = tamper(signedResponse, (doc) => {
        const assertion = assertionOf(doc);
        assertion.setAttributeNS('urn:x', 'x:ID', doc.documentElement?.getAttribute('ID') ?? '');
      });
      expect(outcome(namespaced)).toBe('wrapped');
      const misplaced = tamper(signedAssertion, (doc) => {
        const assertion = assertionOf(doc);
        const signature = signatureOf(assertion);
        assertion.removeChild(signature);
        first(doc, SAML_NS.assertion, 'Subject').appendChild(signature);
      });
      expect(outcome(misplaced)).toBe('wrapped');
      const twice = tamper(signedAssertion, (doc) => {
        const assertion = assertionOf(doc);
        assertion.appendChild(signatureOf(assertion).cloneNode(true));
      });
      expect(outcome(twice)).toBe('wrapped');
    });

    it('[IAM-002] refuses a signature carrying an Object, even a harmless one', () => {
      const attack = tamper(signedAssertion, (doc) => {
        signatureOf(assertionOf(doc)).appendChild(doc.createElementNS(SAML_NS.dsig, 'ds:Object'));
      });
      expect(outcome(attack)).toBe('wrapped');
    });

    it('[IAM-002] never accepts a changed byte with a different person (property)', () => {
      const xml = signedAssertion;
      fc.assert(
        fc.property(
          fc.nat(xml.length - 1),
          fc.constantFrom('a', '<', '>', '"', ' ', '/', '=', '!', '-', 'x'),
          (at, char) => {
            const changed = xml.slice(0, at) + char + xml.slice(at + 1);
            try {
              const result = verify(changed);
              // Some bytes are not signed content (the signature's own prefix, white space
              // inside a tag): then the same person comes out, or nothing.
              expect(result.nameId).toBe('ada@corp.example');
              expect(result.attributes.get('groups')).toEqual(['eng', 'ops']);
            } catch (error) {
              expect(error).toBeInstanceOf(SamlError);
            }
          },
        ),
        { numRuns: 150 },
      );
    });
  });

  describe('the assertion must be for us, now, and answer our request', () => {
    it('[IAM-002] refuses an assertion for another audience, recipient or destination', () => {
      expect(outcome(idp.response({ ...base, audience: 'https://other.test/sp' }))).toBe(
        'audience',
      );
      expect(outcome(idp.response({ ...base, recipient: 'https://other.test/acs' }))).toBe(
        'recipient',
      );
      expect(outcome(idp.response({ ...base, destination: 'https://other.test/acs' }))).toBe(
        'destination',
      );
      // A signed Response must say where it goes.
      expect(outcome(idp.response({ ...base, sign: 'response', destination: null }))).toBe(
        'destination',
      );
      expect(outcome(idp.response({ ...base, destination: null }))).toBe('accepted');
      // The provider vouched for these: they are audited.
      expect(vouched(idp.response({ ...base, audience: 'https://other.test/sp' }))).toBe(true);
      expect(vouched(idp.response({ ...base, sign: 'none' }))).toBe(false);
    });

    it('[IAM-002] refuses another issuer', () => {
      expect(outcome(idp.response({ ...base, issuer: 'https://other-idp.test' }))).toBe('issuer');
    });

    it('[IAM-002] refuses expired and not yet valid assertions, with two minutes of clock skew', () => {
      const issued = new Date('2026-10-28T10:00:00Z');
      const xml = idp.response({ ...base, now: issued, lifetimeSeconds: 300 });
      const at = (seconds: number) => ({ now: new Date(issued.getTime() + seconds * 1000) });
      expect(outcome(xml, at(0))).toBe('accepted');
      expect(outcome(xml, at(300 + 110))).toBe('accepted');
      expect(outcome(xml, at(300 + 130))).toBe('expired');
      expect(outcome(xml, at(-100))).toBe('accepted');
      expect(outcome(xml, at(-60 * 10))).toBe('not_yet_valid');
    });

    it('[IAM-002] refuses a response and an assertion that answer different requests', () => {
      const signed = idp.response(base);
      const swapped = tamper(signed, (doc) => {
        doc.documentElement?.setAttribute('InResponseTo', '_another-request');
      });
      expect(outcome(swapped)).toBe('in_response_to');
    });

    it('[IAM-002] refuses an assertion with no audience or no authentication statement', () => {
      const noAudience = tamper(idp.response({ ...base, sign: 'none' }), (doc) => {
        const restriction = first(doc, SAML_NS.assertion, 'AudienceRestriction');
        restriction.parentNode?.removeChild(restriction);
      });
      const assertionId = assertionOf(
        new DOMParser().parseFromString(noAudience, 'text/xml'),
      ).getAttribute('ID') as string;
      const resigned = signElement(noAudience, assertionId, idp.signing);
      expect(outcome(resigned)).toBe('audience');
      const noStatement = tamper(idp.response({ ...base, sign: 'none' }), (doc) => {
        const statement = first(doc, SAML_NS.assertion, 'AuthnStatement');
        statement.parentNode?.removeChild(statement);
      });
      const id = assertionOf(new DOMParser().parseFromString(noStatement, 'text/xml')).getAttribute(
        'ID',
      ) as string;
      expect(outcome(signElement(noStatement, id, idp.signing))).toBe('subject');
    });
  });
});

describe('SAML requests and metadata (M1-081)', () => {
  it('[IAM-002] sends an AuthnRequest through the HTTP-Redirect binding', () => {
    const url = authnRequestUrl({
      id: '_abc',
      ssoUrl: 'https://idp.saml.test/sso?tenant=1',
      spEntityId: SP,
      acsUrl: ACS,
    });
    expect(url.startsWith('https://idp.saml.test/sso?tenant=1&SAMLRequest=')).toBe(true);
    const request = idp.readRequest(url);
    expect(request).toMatchObject({
      id: '_abc',
      issuer: SP,
      acsUrl: ACS,
      destination: 'https://idp.saml.test/sso?tenant=1',
      protocolBinding: SAML_BINDING.post,
    });
  });

  it('[IAM-002] imports identity provider metadata: entity ID, redirect address, certificates', () => {
    const metadata = parseIdpMetadata(idp.metadata());
    expect(metadata).toEqual({
      entityId: idp.entityId,
      ssoUrl: idp.ssoUrl,
      certificates: readCertificates([idp.signing.certificate]),
    });
    const wrapped = `<md:EntitiesDescriptor xmlns:md="${SAML_NS.metadata}">${idp
      .metadata()
      .replace(/^<\?xml[^>]*>\s*/, '')}</md:EntitiesDescriptor>`;
    expect(parseIdpMetadata(wrapped).entityId).toBe(idp.entityId);
    const twice = wrapped.replace(
      '</md:EntitiesDescriptor>',
      `${idp
        .metadata()
        .replace(/^<\?xml[^>]*>\s*/, '')
        .replace(idp.entityId, 'https://second.test')}</md:EntitiesDescriptor>`,
    );
    expect(() => parseIdpMetadata(twice)).toThrow(MetadataError);
    const postOnly = idp.metadata().replace(/<md:SingleSignOnService[^>]*Redirect[^>]*\/>/, '');
    expect(() => parseIdpMetadata(postOnly)).toThrow(/HTTP-Redirect/);
    const noKey = idp.metadata().replace(/<md:KeyDescriptor[\s\S]*<\/md:KeyDescriptor>/, '');
    expect(() => parseIdpMetadata(noKey)).toThrow(/certificate/);
    expect(() => parseIdpMetadata('<nope')).toThrow(MetadataError);
    expect(() => parseIdpMetadata('<!DOCTYPE x><x/>')).toThrow(MetadataError);
  });

  it('[IAM-002] reads certificates as PEM or bare base64 and refuses anything else', () => {
    const pem = idp.signing.certificate;
    const bare = pem.replace(/-----[A-Z ]+-----|\s+/g, '');
    expect(readCertificates([bare])).toEqual(readCertificates([pem]));
    expect(readCertificates([`${pem}\n${attacker.certificate}`])).toHaveLength(2);
    expect(() => readCertificates(['not a certificate'])).toThrow();
    expect(() => readCertificates(['QUJD'])).toThrow();
    expect(certificateSummary(pem)).toMatchObject({
      fingerprint: expect.stringMatching(/^([0-9A-F]{2}:){31}[0-9A-F]{2}$/),
      subject: 'CN=Fake SAML IdP',
    });
  });

  it('[IAM-002] publishes service provider metadata with the entity ID and the ACS', () => {
    const xml = serviceProviderMetadata({ entityId: SP, acsUrl: ACS });
    const doc = new DOMParser().parseFromString(xml, 'text/xml');
    expect(doc.documentElement?.getAttribute('entityID')).toBe(SP);
    const acs = first(doc, SAML_NS.metadata, 'AssertionConsumerService');
    expect(acs.getAttribute('Location')).toBe(ACS);
    expect(acs.getAttribute('Binding')).toBe(SAML_BINDING.post);
  });
});
