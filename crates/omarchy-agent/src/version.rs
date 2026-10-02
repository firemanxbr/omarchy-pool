//! `X.Y.Z` versions (agent versions) and `vX.Y.Z` release names: numbers only, no
//! pre-release or build suffix, so ordering is plain and nothing is left to interpret.

use std::fmt;

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub struct Version(pub u64, pub u64, pub u64);

impl Version {
    /// `X.Y.Z`, each part ASCII digits without a leading zero (bar `0` itself).
    pub fn parse(s: &str) -> Option<Self> {
        let mut parts = s.split('.');
        let mut next = || -> Option<u64> {
            let p = parts.next()?;
            let digits = !p.is_empty() && p.bytes().all(|b| b.is_ascii_digit());
            if !digits || (p.len() > 1 && p.starts_with('0')) {
                return None;
            }
            p.parse().ok()
        };
        let v = Version(next()?, next()?, next()?);
        parts.next().is_none().then_some(v)
    }

    /// A release name: `vX.Y.Z`.
    pub fn parse_release(s: &str) -> Option<Self> {
        Self::parse(s.strip_prefix('v')?)
    }
}

impl fmt::Display for Version {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}.{}.{}", self.0, self.1, self.2)
    }
}

/// A release, written `vX.Y.Z` wherever the agent stores or shows it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub struct Release(pub Version);

impl Release {
    pub fn parse(s: &str) -> Option<Self> {
        Version::parse_release(s).map(Release)
    }
}

impl fmt::Display for Release {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "v{}", self.0)
    }
}

impl serde::Serialize for Release {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.collect_str(self)
    }
}

impl<'de> serde::Deserialize<'de> for Release {
    fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        let s = String::deserialize(d)?;
        Release::parse(&s).ok_or_else(|| serde::de::Error::custom(format!("{s:?} is not vX.Y.Z")))
    }
}

/// This agent's own version, parsed once from `Cargo.toml`.
pub(crate) fn agent() -> Version {
    Version::parse(crate::AGENT_VERSION).expect("Cargo.toml carries an X.Y.Z version")
}

#[cfg(test)]
mod tests {
    use super::Version;

    #[test]
    fn parses_and_orders_plain_versions_only() {
        assert_eq!(Version::parse("0.4.0"), Some(Version(0, 4, 0)));
        assert!(Version::parse("0.10.0") > Version::parse("0.9.9"));
        assert_eq!(Version::parse_release("v1.20.0"), Some(Version(1, 20, 0)));
        for bad in [
            "",
            "1",
            "1.2",
            "1.2.3.4",
            "01.2.3",
            "1.2.3-rc1",
            "1.2.x",
            " 1.2.3",
            "+1.2.3",
        ] {
            assert_eq!(Version::parse(bad), None, "{bad:?}");
        }
        assert_eq!(Version::parse_release("1.2.3"), None);
        super::agent();
    }
}
