use std::collections::BTreeMap;
use std::path::Path;

use super::super::sshsig::{self, PublicKey};
use super::tests_support::{policy, policy_toml, TestKey};
use super::{file_name, Policy, BUNDLE_NAMESPACE, PINNED, ROLLBACK_NAMESPACE};

const BUNDLE: &[u8] =
    b"an omarchy-host bundle stands here: these bytes are what the fixtures sign\n";

fn fixtures() -> std::path::PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/cosignature")
}

fn fixture(name: &str) -> Vec<u8> {
    std::fs::read(fixtures().join(name)).unwrap_or_else(|e| panic!("{name}: {e}"))
}

fn sigs(pairs: &[(&str, Vec<u8>)]) -> BTreeMap<String, Vec<u8>> {
    pairs
        .iter()
        .map(|(l, s)| ((*l).to_owned(), s.clone()))
        .collect()
}

#[test]
fn a_touch_signature_by_each_kind_of_security_key_counts_once_per_maintainer() {
    let alice = TestKey::ed25519("alice", 1);
    let bob = TestKey::ecdsa("bob");
    let p = policy(2, &[&alice, &bob]);
    let both = sigs(&[
        ("alice", alice.sign(BUNDLE_NAMESPACE, BUNDLE)),
        ("bob", bob.sign(BUNDLE_NAMESPACE, BUNDLE)),
    ]);
    let c = p.check(BUNDLE_NAMESPACE, BUNDLE, &both);
    assert_eq!(c.by(), ["alice", "bob"], "{c:?}");
    assert_eq!(c.require(2, "the bundle"), Ok(()));
    let three = c.require(3, "the bundle").unwrap_err();
    assert!(
        three.contains("needs 3 maintainer co-signature(s)"),
        "{three}"
    );
    // A P-256 signature's halves are as wide as they come, a leading zero or not: many runs
    // of the random nonce cover both.
    for _ in 0..32 {
        let one = sigs(&[("bob", bob.sign(BUNDLE_NAMESPACE, BUNDLE))]);
        assert_eq!(p.check(BUNDLE_NAMESPACE, BUNDLE, &one).count(), 1);
    }
    // The user-verification flag (a PIN) beside the touch, and a SHA-256 message hash: both
    // what OpenSSH may make.
    let uv = sigs(&[(
        "alice",
        alice.sign_with(BUNDLE_NAMESPACE, BUNDLE, 0x05, "sha256"),
    )]);
    assert_eq!(p.check(BUNDLE_NAMESPACE, BUNDLE, &uv).by(), ["alice"]);
}

#[test]
fn a_wrong_key_other_bytes_another_namespace_or_no_touch_count_for_nothing() {
    let alice = TestKey::ed25519("alice", 1);
    let carol = TestKey::ed25519("carol", 3);
    let p = policy(1, &[&alice]);
    let refused = |s: Vec<u8>, message: &[u8], namespace: &str| {
        let c = p.check(namespace, message, &sigs(&[("alice", s)]));
        assert_eq!(c.count(), 0, "{c:?}");
        c.require(1, "the bundle").unwrap_err()
    };
    // Carol's valid signature, put where Alice's goes.
    let why = refused(
        carol.sign(BUNDLE_NAMESPACE, BUNDLE),
        BUNDLE,
        BUNDLE_NAMESPACE,
    );
    assert!(why.contains("alice: signed by another key"), "{why}");
    // Alice's, over other bytes.
    let why = refused(
        alice.sign(BUNDLE_NAMESPACE, b"another bundle"),
        BUNDLE,
        BUNDLE_NAMESPACE,
    );
    assert!(why.contains("does not verify"), "{why}");
    // Alice's over a statement does not co-sign a bundle, nor the other way round.
    let why = refused(
        alice.sign(ROLLBACK_NAMESPACE, BUNDLE),
        BUNDLE,
        BUNDLE_NAMESPACE,
    );
    assert!(
        why.contains("signed for namespace \"rollback@omarchy-pool.org\""),
        "{why}"
    );
    refused(
        alice.sign(BUNDLE_NAMESPACE, BUNDLE),
        BUNDLE,
        ROLLBACK_NAMESPACE,
    );
    // Made without a touch (malware on the laptop asking the key).
    let why = refused(
        alice.sign_with(BUNDLE_NAMESPACE, BUNDLE, 0x00, "sha512"),
        BUNDLE,
        BUNDLE_NAMESPACE,
    );
    assert!(why.contains("without a touch"), "{why}");
    // Another hash.
    let why = refused(
        alice.sign_with(BUNDLE_NAMESPACE, BUNDLE, 0x01, "md5"),
        BUNDLE,
        BUNDLE_NAMESPACE,
    );
    assert!(why.contains("neither sha512 nor sha256"), "{why}");
    // Not a signature at all, cut short, or with a byte more: refused, never a panic.
    let good = alice.sign(BUNDLE_NAMESPACE, BUNDLE);
    let text = String::from_utf8(good.clone()).unwrap();
    let mut bad: Vec<Vec<u8>> = vec![
        Vec::new(),
        b"-----BEGIN SSH SIGNATURE-----\n!!\n-----END SSH SIGNATURE-----\n".to_vec(),
        text.replace("-----END SSH SIGNATURE-----", "").into_bytes(),
        vec![b'A'; super::super::sshsig::MAX_ARMORED + 1],
    ];
    let blob = {
        use base64::Engine as _;
        let inner: String = text.lines().filter(|l| !l.starts_with("-----")).collect();
        base64::engine::general_purpose::STANDARD
            .decode(inner)
            .unwrap()
    };
    for cut in [0, 6, 10, blob.len() / 2, blob.len() - 1] {
        bad.push(armor(&blob[..cut]));
    }
    let mut longer = blob.clone();
    longer.push(0);
    bad.push(armor(&longer));
    for b in bad {
        refused(b, BUNDLE, BUNDLE_NAMESPACE);
    }
    assert_eq!(
        p.check(BUNDLE_NAMESPACE, BUNDLE, &sigs(&[("alice", good)]))
            .count(),
        1
    );
}

fn armor(blob: &[u8]) -> Vec<u8> {
    use base64::Engine as _;
    format!(
        "-----BEGIN SSH SIGNATURE-----\n{}\n-----END SSH SIGNATURE-----\n",
        base64::engine::general_purpose::STANDARD.encode(blob)
    )
    .into_bytes()
}

#[test]
fn a_signature_by_someone_not_in_maintainers_toml_counts_for_nothing() {
    let alice = TestKey::ed25519("alice", 1);
    let carol = TestKey::ed25519("carol", 3);
    let p = policy(1, &[&alice]);
    let c = p.check(
        BUNDLE_NAMESPACE,
        BUNDLE,
        &sigs(&[("carol", carol.sign(BUNDLE_NAMESPACE, BUNDLE))]),
    );
    assert_eq!(c.count(), 0);
    let why = c.require(1, "v1.2.3's bundle").unwrap_err();
    assert!(
        why.contains("carol: no key of theirs is pinned (factory/MAINTAINERS.toml)"),
        "{why}"
    );
    assert!(
        why.starts_with("v1.2.3's bundle needs 1 maintainer co-signature(s)"),
        "{why}"
    );
}

#[test]
fn one_of_n_takes_any_one_maintainer_and_two_of_n_takes_two_different_ones() {
    let alice = TestKey::ed25519("alice", 1);
    let bob = TestKey::ed25519("bob", 2);
    let carol = TestKey::ecdsa("carol");
    let alone = sigs(&[("bob", bob.sign(BUNDLE_NAMESPACE, BUNDLE))]);
    let one_of_three = policy(1, &[&alice, &bob, &carol]);
    assert_eq!(
        one_of_three
            .check(BUNDLE_NAMESPACE, BUNDLE, &alone)
            .require(one_of_three.threshold(), "the bundle"),
        Ok(())
    );
    let two_of_three = policy(2, &[&alice, &bob, &carol]);
    let why = two_of_three
        .check(BUNDLE_NAMESPACE, BUNDLE, &alone)
        .require(two_of_three.threshold(), "the bundle")
        .unwrap_err();
    assert!(
        why.contains("needs 2") && why.contains("1 verifies (bob)"),
        "{why}"
    );
    // Bob's signature twice, once under Carol's name, is still one maintainer.
    let twice = sigs(&[
        ("bob", bob.sign(BUNDLE_NAMESPACE, BUNDLE)),
        ("carol", bob.sign(BUNDLE_NAMESPACE, BUNDLE)),
    ]);
    assert_eq!(
        two_of_three.check(BUNDLE_NAMESPACE, BUNDLE, &twice).by(),
        ["bob"]
    );
    let two = sigs(&[
        ("bob", bob.sign(BUNDLE_NAMESPACE, BUNDLE)),
        ("carol", carol.sign(BUNDLE_NAMESPACE, BUNDLE)),
    ]);
    assert_eq!(
        two_of_three
            .check(BUNDLE_NAMESPACE, BUNDLE, &two)
            .require(2, "the bundle"),
        Ok(())
    );
    // Nothing asked: a threshold of 0 takes a bundle with no co-signature, while a rollback
    // deeper than 14 days still needs one.
    let none = policy(0, &[&alice]);
    assert_eq!(none.threshold(), 0);
    assert_eq!(none.deep_rollback(), 1);
    assert_eq!(two_of_three.deep_rollback(), 2);
    assert_eq!(Policy::default().deep_rollback(), 1);
    assert_eq!(Policy::default().logins().count(), 0);
}

#[test]
fn the_policy_refuses_a_threshold_its_keys_cannot_meet_a_shared_key_and_a_key_in_a_file() {
    let alice = TestKey::ed25519("alice", 1);
    let bob = TestKey::ecdsa("bob");
    let err = |t: &str| Policy::parse(t).unwrap_err();
    assert!(err(&policy_toml(3, &[&alice, &bob])).contains("never met"));
    assert!(err("threshold = 1\n").contains("never met"));
    let twin = TestKey::ed25519("twin", 1);
    assert!(err(&policy_toml(1, &[&alice, &twin])).contains("the same key"));
    let plain = String::from_utf8(fixture("plain.pub")).unwrap();
    let e = err(&format!(
        "threshold = 1\n[keys]\nalice = \"{}\"\n",
        plain.trim()
    ));
    assert!(
        e.contains("not a FIDO key") && e.contains("not offline"),
        "{e}"
    );
    assert!(
        err(&policy_toml(0, &[&alice]).replace("alice =", "\"not a login\" ="))
            .contains("not a login")
    );
    assert!(err("threshold = 0\nextra = 1\n").contains("unknown field"));
    assert!(err("threshold = -1\n").contains("co-signature policy"));
    let line = alice.public_line();
    let swapped = line.replace(
        super::super::sshsig::ED25519_SK,
        super::super::sshsig::ECDSA_SK,
    );
    assert!(
        err(&format!("threshold = 0\n[keys]\nalice = \"{swapped}\"\n")).contains("its blob is")
    );
    assert!(
        err("threshold = 0\n[keys]\nalice = \"sk-ssh-ed25519@openssh.com !!\"\n")
            .contains("not base64")
    );
    assert!(
        err("threshold = 0\n[keys]\nalice = \"ssh-rsa AAAAB3NzaC1yc2E=\"\n").contains("neither")
    );
    // What check-governance writes, comments and all, reads.
    let p = policy(1, &[&alice, &bob]);
    assert_eq!(p.logins().collect::<Vec<_>>(), ["alice", "bob"]);
    assert_eq!(p.threshold(), 1);
    assert_eq!(
        file_name("omarchy-host-v1.2.3.tar.gz", "alice"),
        "omarchy-host-v1.2.3.tar.gz.alice.sshsig"
    );
}

#[test]
fn a_backup_key_is_the_same_maintainer_so_a_key_can_be_rotated_or_lost_under_n_of_n() {
    let alice = TestKey::ed25519("alice", 1);
    let spare = TestKey::ed25519("alice", 9);
    let bob = TestKey::ecdsa("bob");
    let carol = TestKey::ed25519("carol", 3);
    let toml = |threshold: usize, alices: &[&TestKey]| {
        let lines: Vec<String> = alices
            .iter()
            .map(|k| format!("\"{}\"", k.public_line()))
            .collect();
        format!(
            "threshold = {threshold}\n[keys]\nalice = [{}]\nbob = \"{}\"\n",
            lines.join(", "),
            bob.public_line()
        )
    };
    // 2-of-2, Alice with a backup key: either of hers is her one co-signature.
    let both = Policy::parse(&toml(2, &[&alice, &spare])).unwrap();
    assert_eq!(both.logins().collect::<Vec<_>>(), ["alice", "bob"]);
    let by = |p: &Policy, a: &TestKey| {
        p.check(
            BUNDLE_NAMESPACE,
            BUNDLE,
            &sigs(&[
                ("alice", a.sign(BUNDLE_NAMESPACE, BUNDLE)),
                ("bob", bob.sign(BUNDLE_NAMESPACE, BUNDLE)),
            ]),
        )
        .require(p.threshold(), "the bundle")
    };
    assert_eq!(by(&both, &alice), Ok(()));
    assert_eq!(by(&both, &spare), Ok(()));
    // Carol's at Alice's name is another key's; Alice's backup without a touch says that.
    let e = by(&both, &carol).unwrap_err();
    assert!(e.contains("alice: signed by another key"), "{e}");
    let untouched = sigs(&[(
        "alice",
        spare.sign_with(BUNDLE_NAMESPACE, BUNDLE, 0x00, "sha512"),
    )]);
    let c = both.check(BUNDLE_NAMESPACE, BUNDLE, &untouched);
    assert_eq!(
        c.refused(),
        ["alice: made without a touch (the security key's user-presence flag is off)"]
    );
    // Rotation under 2-of-2: the agent that pins only the old key takes the release that
    // adds the new one beside it, co-signed with the old; that release's agent takes the
    // next, which drops the old key, co-signed with the new.
    let old = Policy::parse(&toml(2, &[&alice])).unwrap();
    let overlap = Policy::parse(&toml(2, &[&alice, &spare])).unwrap();
    let new = Policy::parse(&toml(2, &[&spare])).unwrap();
    assert_eq!(by(&old, &alice), Ok(()));
    assert_eq!(by(&overlap, &alice), Ok(()));
    assert_eq!(by(&overlap, &spare), Ok(()));
    assert_eq!(by(&new, &spare), Ok(()));
    assert!(by(&new, &alice).is_err());
    // A list that is empty, a key listed twice, or one key under two logins: refused.
    let err = |t: &str| Policy::parse(t).unwrap_err();
    assert!(err("threshold = 0\n[keys]\nalice = []\n").contains("alice lists no key"));
    assert!(err(&toml(1, &[&alice, &alice])).contains("alice lists the same key twice"));
    let shared = format!(
        "threshold = 1\n[keys]\nalice = [\"{}\", \"{}\"]\nbob = \"{}\"\n",
        alice.public_line(),
        spare.public_line(),
        spare.public_line()
    );
    assert!(err(&shared).contains("have the same key"));
    // The threshold counts maintainers, not keys.
    assert!(err(&toml(3, &[&alice, &spare])).contains("never met"));
}

#[test]
fn the_pinned_policy_reads_and_can_be_met() {
    let p = Policy::parse(PINNED).expect("the pinned maintainers.toml reads");
    assert!(p.threshold() <= p.logins().count());
    assert_eq!(Policy::pinned(), p);
}

// ---------------------------------------------------------------------------------------
// The fixtures: OpenSSH's framing, both ways (tests/cosignature.sh runs `ssh-keygen -Y
// verify` on the ones made here).

#[test]
fn a_signature_openssh_made_verifies_here_so_the_framing_is_openssh_s() {
    // `ssh-keygen -t ed25519` and `ssh-keygen -Y sign -n host-bundle@omarchy-pool.org`,
    // OpenSSH 9.6 (the private key was not kept).
    let plain = PublicKey::parse(std::str::from_utf8(&fixture("plain.pub")).unwrap()).unwrap();
    assert!(!plain.is_fido());
    let sig = fixture("bundle.plain.sshsig");
    assert_eq!(
        sshsig::verify(&plain, BUNDLE_NAMESPACE, &fixture("bundle"), &sig),
        Ok(())
    );
    assert!(sshsig::verify(&plain, ROLLBACK_NAMESPACE, &fixture("bundle"), &sig).is_err());
    assert!(sshsig::verify(&plain, BUNDLE_NAMESPACE, b"other bytes", &sig).is_err());
}

#[test]
fn the_security_key_fixtures_verify_and_are_refused_as_they_should() {
    let key = |n: &str| String::from_utf8(fixture(&format!("{n}.pub"))).unwrap();
    let p = Policy::parse(&format!(
        "threshold = 2\n[keys]\nalice = \"{}\"\nbob = \"{}\"\n",
        key("alice").trim(),
        key("bob").trim()
    ))
    .unwrap();
    let bundle = fixture("bundle");
    let read = |names: &[&str]| -> BTreeMap<String, Vec<u8>> {
        names
            .iter()
            .map(|login| ((*login).to_owned(), fixture(&file_name("bundle", login))))
            .collect()
    };
    let c = p.check(BUNDLE_NAMESPACE, &bundle, &read(&["alice", "bob", "carol"]));
    assert_eq!(c.by(), ["alice", "bob"], "{c:?}");
    assert!(c
        .require(3, "the bundle")
        .unwrap_err()
        .contains("carol: no key"));
    let statement = fixture("statement.json");
    let st = sigs(&[("alice", fixture(&file_name("statement.json", "alice")))]);
    assert_eq!(p.check(ROLLBACK_NAMESPACE, &statement, &st).by(), ["alice"]);
    assert_eq!(p.check(BUNDLE_NAMESPACE, &statement, &st).count(), 0);
    for (name, why) in [
        ("bundle.untouched.sshsig", "without a touch"),
        ("bundle.wrong-namespace.sshsig", "signed for namespace"),
    ] {
        let c = p.check(
            BUNDLE_NAMESPACE,
            &bundle,
            &sigs(&[("alice", fixture(name))]),
        );
        assert!(
            c.require(1, "the bundle").unwrap_err().contains(why),
            "{name}: {c:?}"
        );
    }
}

/// Writes `tests/fixtures/cosignature/`'s keys and signatures over its `bundle` (a stand-in
/// host bundle, a `.tar.gz` with a `manifest.json`, as `factory/bin/co-sign release` reads
/// one) and `statement.json`: Alice's and Carol's keys are the same every run, Bob's (P-256)
/// and his signatures are new. `alice.pub` and `bob.pub` are `tests/cosignature.sh`'s
/// maintainers; `plain.pub` and `bundle.plain.sshsig` are OpenSSH's (`ssh-keygen -t ed25519`,
/// `-Y sign`), made again by hand when `bundle` changes.
#[test]
#[ignore = "writes tests/fixtures/cosignature/; run by hand to make them again"]
fn write_the_fixtures() {
    let dir = fixtures();
    std::fs::create_dir_all(&dir).unwrap();
    let write = |n: &str, b: &[u8]| std::fs::write(dir.join(n), b).unwrap();
    let alice = TestKey::ed25519("alice", 1);
    let bob = TestKey::ecdsa("bob");
    let carol = TestKey::ed25519("carol", 3);
    let bundle = fixture("bundle");
    let statement = br#"{"schema":1,"seq":9,"to":"v1.0.1","retracts_through":"v1.2.0","issued":"2027-02-20T08:00:00Z","agent_to":null,"run":"https://github.com/firemanxbr/omarchy-pool/actions/runs/9"}
"#;
    write("statement.json", statement);
    for k in [&alice, &bob, &carol] {
        write(
            &format!("{}.pub", k.login),
            format!("{}\n", k.public_line()).as_bytes(),
        );
        write(
            &file_name("bundle", &k.login),
            &k.sign(BUNDLE_NAMESPACE, &bundle),
        );
    }
    write(
        &file_name("statement.json", "alice"),
        &alice.sign(ROLLBACK_NAMESPACE, statement),
    );
    write(
        "bundle.untouched.sshsig",
        &alice.sign_with(BUNDLE_NAMESPACE, &bundle, 0x00, "sha512"),
    );
    write(
        "bundle.wrong-namespace.sshsig",
        &alice.sign(ROLLBACK_NAMESPACE, &bundle),
    );
}
