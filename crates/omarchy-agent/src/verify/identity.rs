//! Who signed: the claims Fulcio wrote into the signing certificate, checked against the
//! pinned identity (design v2 §5.1). This runs after the cryptographic check, on the leaf
//! certificate that check vouched for, and does not depend on the Sigstore crate, so a
//! fallback verifier (D2) keeps exactly the same authorization.

use std::fmt;

use x509_cert::der::asn1::Utf8StringRef;
use x509_cert::der::{Decode, Encode};
use x509_cert::ext::pkix::name::GeneralName;
use x509_cert::ext::pkix::SubjectAltName;
use x509_cert::Certificate;

/// The identity a signature must come from, value for value.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Pins {
    pub repository: &'static str,
    pub workflow: &'static str,
    pub git_ref: &'static str,
    pub issuer: &'static str,
    pub event_name: &'static str,
    pub repository_id: &'static str,
    pub repository_owner_id: &'static str,
}

const REPOSITORY: &str = "firemanxbr/omarchy-pool";
const ISSUER: &str = "https://token.actions.githubusercontent.com";
/// `gh api repos/firemanxbr/omarchy-pool --jq '.id, .owner.id'`. The ids survive a
/// rename or transfer of the repository, which a name alone would not.
const REPOSITORY_ID: &str = "1366612060";
const REPOSITORY_OWNER_ID: &str = "2116404";

/// Host bundles: `release.yml` dispatched on main.
pub const RELEASE: Pins = Pins {
    repository: REPOSITORY,
    workflow: "release.yml",
    git_ref: "refs/heads/main",
    issuer: ISSUER,
    event_name: "workflow_dispatch",
    repository_id: REPOSITORY_ID,
    repository_owner_id: REPOSITORY_OWNER_ID,
};

/// Rollback statements: `rollback.yml` dispatched on main.
pub const ROLLBACK: Pins = Pins {
    workflow: "rollback.yml",
    ..RELEASE
};

impl Pins {
    /// The certificate's one SAN: the workflow file at the ref it ran from.
    pub fn san(&self) -> String {
        format!(
            "https://github.com/{}/.github/workflows/{}@{}",
            self.repository, self.workflow, self.git_ref
        )
    }
}

/// Which pinned claim a certificate failed, and what it carried instead.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Mismatch {
    /// A claim the pins need is absent, repeated or unreadable.
    Unreadable(String),
    Issuer {
        found: String,
    },
    /// The SAN names another repository.
    Repository {
        found: String,
    },
    /// The SAN names another workflow file (or is not a workflow SAN at all).
    Workflow {
        found: String,
    },
    /// The workflow ran from another ref (a branch other than main, a tag, a pull request).
    Ref {
        found: String,
    },
    EventName {
        found: String,
    },
    RepositoryId {
        found: String,
    },
    RepositoryOwnerId {
        found: String,
    },
}

impl Mismatch {
    /// A short, stable name for the failed pin (for logs, reports and tests).
    pub fn pin(&self) -> &'static str {
        match self {
            Mismatch::Unreadable(_) => "certificate",
            Mismatch::Issuer { .. } => "issuer",
            Mismatch::Repository { .. } => "repository",
            Mismatch::Workflow { .. } => "workflow",
            Mismatch::Ref { .. } => "ref",
            Mismatch::EventName { .. } => "event_name",
            Mismatch::RepositoryId { .. } => "repository_id",
            Mismatch::RepositoryOwnerId { .. } => "repository_owner_id",
        }
    }
}

impl fmt::Display for Mismatch {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Mismatch::Unreadable(why) => write!(f, "signing certificate: {why}"),
            Mismatch::Issuer { found }
            | Mismatch::Repository { found }
            | Mismatch::Workflow { found }
            | Mismatch::Ref { found }
            | Mismatch::EventName { found }
            | Mismatch::RepositoryId { found }
            | Mismatch::RepositoryOwnerId { found } => {
                write!(
                    f,
                    "signer {} is not the pinned one (found {found:?})",
                    self.pin()
                )
            }
        }
    }
}

/// Fulcio's certificate extensions (1.3.6.1.4.1.57264.1.*), the DER-encoded (v2) ones.
mod oid {
    use x509_cert::der::oid::ObjectIdentifier as Oid;
    pub const ISSUER: Oid = Oid::new_unwrap("1.3.6.1.4.1.57264.1.8");
    pub const REPOSITORY_ID: Oid = Oid::new_unwrap("1.3.6.1.4.1.57264.1.15");
    pub const REPOSITORY_OWNER_ID: Oid = Oid::new_unwrap("1.3.6.1.4.1.57264.1.17");
    pub const EVENT_NAME: Oid = Oid::new_unwrap("1.3.6.1.4.1.57264.1.20");
    pub const SUBJECT_ALT_NAME: Oid = Oid::new_unwrap("2.5.29.17");
}

/// The claims of a signing certificate that the pins cover.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Identity {
    pub san: String,
    pub issuer: String,
    pub event_name: String,
    pub repository_id: String,
    pub repository_owner_id: String,
}

impl Identity {
    pub(crate) fn from_der(der: &[u8]) -> Result<Self, Mismatch> {
        let bad = |why: String| Mismatch::Unreadable(why);
        let cert = Certificate::from_der(der).map_err(|e| bad(format!("not X.509: {e}")))?;
        let exts = cert.tbs_certificate.extensions.unwrap_or_default();
        let one = |oid| -> Result<&[u8], Mismatch> {
            let mut found = exts.iter().filter(|e| e.extn_id == oid);
            match (found.next(), found.next()) {
                (Some(e), None) => Ok(e.extn_value.as_bytes()),
                (None, _) => Err(bad(format!("no {oid} extension"))),
                (Some(_), Some(_)) => Err(bad(format!("{oid} extension repeated"))),
            }
        };
        let text = |oid| -> Result<String, Mismatch> {
            let v = Utf8StringRef::from_der(one(oid)?)
                .map_err(|e| bad(format!("{oid} is not a UTF8String: {e}")))?;
            Ok(v.as_str().to_owned())
        };
        let sans = SubjectAltName::from_der(one(oid::SUBJECT_ALT_NAME)?)
            .map_err(|e| bad(format!("subject alternative name: {e}")))?;
        let san = match sans.0.as_slice() {
            [GeneralName::UniformResourceIdentifier(uri)] => uri.as_str().to_owned(),
            [other] => {
                let der = other.to_der().unwrap_or_default();
                return Err(Mismatch::Workflow {
                    found: format!("a non-URI SAN ({} bytes)", der.len()),
                });
            }
            _ => {
                return Err(bad(format!(
                    "{} subject alternative names, not one",
                    sans.0.len()
                )))
            }
        };
        Ok(Identity {
            san,
            issuer: text(oid::ISSUER)?,
            event_name: text(oid::EVENT_NAME)?,
            repository_id: text(oid::REPOSITORY_ID)?,
            repository_owner_id: text(oid::REPOSITORY_OWNER_ID)?,
        })
    }

    /// Every pinned value, exactly; the first that differs is the reason.
    pub(crate) fn check(&self, pins: &Pins) -> Result<(), Mismatch> {
        if self.issuer != pins.issuer {
            return Err(Mismatch::Issuer {
                found: self.issuer.clone(),
            });
        }
        if self.san != pins.san() {
            let found = self.san.clone();
            let Some((repo, workflow, git_ref)) = split_workflow_san(&self.san) else {
                return Err(Mismatch::Workflow { found });
            };
            return Err(if repo != pins.repository {
                Mismatch::Repository { found }
            } else if workflow != pins.workflow {
                Mismatch::Workflow { found }
            } else if git_ref != pins.git_ref {
                Mismatch::Ref { found }
            } else {
                Mismatch::Workflow { found }
            });
        }
        if self.event_name != pins.event_name {
            return Err(Mismatch::EventName {
                found: self.event_name.clone(),
            });
        }
        if self.repository_id != pins.repository_id {
            return Err(Mismatch::RepositoryId {
                found: self.repository_id.clone(),
            });
        }
        if self.repository_owner_id != pins.repository_owner_id {
            return Err(Mismatch::RepositoryOwnerId {
                found: self.repository_owner_id.clone(),
            });
        }
        Ok(())
    }
}

/// `https://github.com/<owner>/<repo>/.github/workflows/<file>@<ref>` into its parts.
fn split_workflow_san(san: &str) -> Option<(&str, &str, &str)> {
    let rest = san.strip_prefix("https://github.com/")?;
    let (path, git_ref) = rest.split_once('@')?;
    let (repo, workflow) = path.split_once("/.github/workflows/")?;
    Some((repo, workflow, git_ref))
}

#[cfg(test)]
pub(crate) mod tests {
    use super::{Identity, Mismatch, RELEASE, ROLLBACK};

    /// A DER `UTF8String`, the encoding of Fulcio's v2 extensions.
    fn utf8(s: &str) -> Vec<u8> {
        let mut out = vec![0x0c];
        match s.len() {
            n @ 0..=127 => out.push(u8::try_from(n).unwrap()),
            n => out.extend([0x81, u8::try_from(n).unwrap()]),
        }
        out.extend_from_slice(s.as_bytes());
        out
    }

    /// The claims of a signing certificate, one of them changed at a time.
    #[derive(Clone)]
    pub(crate) struct Claims {
        pub san: String,
        pub issuer: &'static str,
        pub event_name: &'static str,
        pub repository_id: &'static str,
        pub repository_owner_id: &'static str,
    }

    impl Default for Claims {
        fn default() -> Self {
            Claims {
                san: RELEASE.san(),
                issuer: RELEASE.issuer,
                event_name: RELEASE.event_name,
                repository_id: RELEASE.repository_id,
                repository_owner_id: RELEASE.repository_owner_id,
            }
        }
    }

    impl Claims {
        /// A certificate carrying these claims as Fulcio writes them (self-signed: only
        /// the claims matter here; the chain is the cryptographic check's job).
        pub(crate) fn certificate(&self) -> Vec<u8> {
            use rcgen::{CertificateParams, CustomExtension, KeyPair, SanType};
            let mut p = CertificateParams::new(Vec::<String>::new()).unwrap();
            p.subject_alt_names = vec![SanType::URI(self.san.clone().try_into().unwrap())];
            let fulcio = |last: u64, v: &str| {
                CustomExtension::from_oid_content(&[1, 3, 6, 1, 4, 1, 57264, 1, last], utf8(v))
            };
            p.custom_extensions = vec![
                fulcio(8, self.issuer),
                fulcio(20, self.event_name),
                fulcio(15, self.repository_id),
                fulcio(17, self.repository_owner_id),
            ];
            p.self_signed(&KeyPair::generate().unwrap())
                .unwrap()
                .der()
                .to_vec()
        }
    }

    fn mismatch(claims: &Claims) -> Mismatch {
        let id = Identity::from_der(&claims.certificate()).unwrap();
        id.check(&RELEASE).unwrap_err()
    }

    #[test]
    fn the_pinned_claims_pass() {
        let id = Identity::from_der(&Claims::default().certificate()).unwrap();
        id.check(&RELEASE).unwrap();
        assert_eq!(id.check(&ROLLBACK).unwrap_err().pin(), "workflow");
    }

    #[test]
    fn each_other_claim_fails_with_its_own_reason() {
        let base = Claims::default();
        let other_ref = RELEASE.san().replace("refs/heads/main", "refs/heads/other");
        let cases = [
            (
                Claims {
                    san: other_ref,
                    ..base.clone()
                },
                "ref",
            ),
            (
                Claims {
                    san: RELEASE.san().replace("refs/heads/main", "refs/tags/v1.0.0"),
                    ..base.clone()
                },
                "ref",
            ),
            (
                Claims {
                    san: RELEASE.san().replace("release.yml", "ci.yml"),
                    ..base.clone()
                },
                "workflow",
            ),
            (
                Claims {
                    san: RELEASE.san().replace("omarchy-pool", "omarchy-fork"),
                    ..base.clone()
                },
                "repository",
            ),
            (
                Claims {
                    san: "https://example.com/not-a-workflow".into(),
                    ..base.clone()
                },
                "workflow",
            ),
            (
                Claims {
                    repository_id: "1",
                    ..base.clone()
                },
                "repository_id",
            ),
            (
                Claims {
                    repository_owner_id: "1",
                    ..base.clone()
                },
                "repository_owner_id",
            ),
            (
                Claims {
                    event_name: "push",
                    ..base.clone()
                },
                "event_name",
            ),
            (
                Claims {
                    event_name: "pull_request_target",
                    ..base.clone()
                },
                "event_name",
            ),
            (
                Claims {
                    issuer: "https://accounts.google.com",
                    ..base.clone()
                },
                "issuer",
            ),
        ];
        for (claims, pin) in cases {
            let m = mismatch(&claims);
            assert_eq!(m.pin(), pin, "{m}");
            assert!(m.to_string().contains(pin), "{m}");
        }
    }

    #[test]
    fn a_certificate_without_the_claims_is_unreadable() {
        use rcgen::{CertificateParams, KeyPair};
        let der = CertificateParams::new(vec!["example.com".to_owned()])
            .unwrap()
            .self_signed(&KeyPair::generate().unwrap())
            .unwrap()
            .der()
            .to_vec();
        assert!(matches!(
            Identity::from_der(&der),
            Err(Mismatch::Workflow { .. } | Mismatch::Unreadable(_))
        ));
        assert!(matches!(
            Identity::from_der(b"junk"),
            Err(Mismatch::Unreadable(_))
        ));
    }
}
