//! #330's acceptance criteria in the run loop, against the fake engine and pool: a bundle
//! without the maintainers' co-signature is refused once the agent requires it (1-of-N and
//! 2-of-N, a wrong key, someone not pinned, GitHub not answering), a higher agent is not
//! taken from one, and a rollback statement deeper than 14 days is taken only with it.

use crate::run::fake::{
    cosign, cosign_statement, publish, publish_agent, relay_statement, Ships, World, T0,
};
use crate::verify::cosignature::tests_support::{policy, TestKey};
use crate::verify::cosignature::{self, BUNDLE_NAMESPACE};
use crate::version::{self, Release, Version};

fn r(s: &str) -> Option<Release> {
    Release::parse(s)
}

fn refused(w: &mut World, target: &str, reason: &str) -> String {
    w.target(target, None);
    w.round_now();
    let (outcome, detail) = w.outcome();
    assert_eq!(outcome, "refused", "{target}: {detail}");
    assert!(
        detail.contains(&format!("refused ({reason})")),
        "{target}: {detail}"
    );
    assert_eq!(w.step(), "idle", "{target}");
    detail
}

#[test]
fn a_bundle_without_the_maintainers_co_signature_is_refused_once_the_agent_requires_it() {
    let mut w = World::running_v1();
    let alice = TestKey::ed25519("alice", 1);
    let bob = TestKey::ecdsa("bob");
    let carol = TestKey::ed25519("carol", 3);

    // An agent that pins no threshold takes a release on release.yml's signature alone,
    // and asks GitHub for no co-signature.
    w.release("v1.1.0");
    w.target("v1.1.0", None);
    w.round();
    assert_eq!(w.applied().as_deref(), Some("v1.1.0"));
    assert!(w.remote.borrow().asked_if_any.is_empty());

    // This agent pins 1-of-2 (Alice, Bob). v1.2.0 raises min_release and revokes v1.1.0:
    // without a co-signature it is refused, and none of that is merged.
    *w.cosign.borrow_mut() = policy(1, &[&alice, &bob]);
    publish(
        &w.remote,
        "v1.2.0",
        "2027-01-14T08:00:00Z",
        "v1.1.0",
        &["v1.1.0"],
        "",
    );
    let changes = w.changes().len();
    let detail = refused(&mut w, "v1.2.0", "cosignature");
    assert!(
        detail.contains("v1.2.0's bundle needs 1 maintainer co-signature(s) (factory/MAINTAINERS.toml); 0 verify"),
        "{detail}"
    );
    assert_eq!(
        w.remote.borrow().asked_if_any,
        [
            "omarchy-host-v1.2.0.tar.gz.alice.sshsig",
            "omarchy-host-v1.2.0.tar.gz.bob.sshsig"
        ]
    );
    assert_eq!(w.agent.state.min_release, r("v1.0.0"));
    assert!(w.agent.state.revoked.is_empty());
    assert_eq!(w.applied().as_deref(), Some("v1.1.0"));

    // Carol is in no MAINTAINERS.toml this agent pins: her valid signature, put up as
    // Alice's, is another key's.
    let archive = w.remote.borrow().assets["v1.2.0/omarchy-host-v1.2.0.tar.gz"].clone();
    w.remote.borrow_mut().assets.insert(
        "v1.2.0/omarchy-host-v1.2.0.tar.gz.alice.sshsig".into(),
        carol.sign(BUNDLE_NAMESPACE, &archive),
    );
    let detail = refused(&mut w, "v1.2.0", "cosignature");
    assert!(detail.contains("alice: signed by another key"), "{detail}");
    assert_eq!(w.changes().len(), changes, "a refusal changed the engine");

    // Alice co-signs: v1.2.0 goes, and her signature is kept beside the bundle.
    cosign(&w.remote, "v1.2.0", &alice);
    w.round();
    assert_eq!(w.applied().as_deref(), Some("v1.2.0"), "{:?}", w.outcome());
    assert_eq!(w.agent.state.min_release, r("v1.1.0"));
    let kept = w.agent.paths.bundles().join(cosignature::file_name(
        "omarchy-host-v1.2.0.tar.gz",
        "alice",
    ));
    assert!(kept.exists());

    // 2-of-2: Alice's alone is refused, Bob's beside it takes v1.3.0.
    *w.cosign.borrow_mut() = policy(2, &[&alice, &bob]);
    w.release("v1.3.0");
    cosign(&w.remote, "v1.3.0", &alice);
    let detail = refused(&mut w, "v1.3.0", "cosignature");
    assert!(
        detail.contains("needs 2 maintainer co-signature(s)")
            && detail.contains("1 verifies (alice)"),
        "{detail}"
    );
    cosign(&w.remote, "v1.3.0", &bob);
    w.round();
    assert_eq!(w.applied().as_deref(), Some("v1.3.0"), "{:?}", w.outcome());

    // A release pruned takes its co-signatures with it.
    w.release("v1.4.0");
    cosign(&w.remote, "v1.4.0", &alice);
    cosign(&w.remote, "v1.4.0", &bob);
    w.target("v1.4.0", None);
    w.round();
    assert_eq!(w.applied().as_deref(), Some("v1.4.0"), "{:?}", w.outcome());
    assert!(!kept.exists(), "v1.2.0's co-signature outlived its bundle");
}

#[test]
fn github_not_answering_for_a_co_signature_holds_the_release_and_refuses_nothing() {
    let mut w = World::running_v1();
    let alice = TestKey::ed25519("alice", 1);
    *w.cosign.borrow_mut() = policy(1, &[&alice]);
    w.release("v1.1.0");
    refused(&mut w, "v1.1.0", "cosignature");
    // Alice co-signs, but GitHub does not answer: no decision now, said as the pool's.
    cosign(&w.remote, "v1.1.0", &alice);
    w.remote.borrow_mut().assets_unanswered = true;
    w.round_now();
    let (outcome, detail) = w.outcome();
    assert_eq!(outcome, "pool-unreachable", "{detail}");
    assert!(
        detail.contains("v1.1.0's co-signatures: omarchy-host-v1.1.0.tar.gz.alice.sshsig: github.com did not answer"),
        "{detail}"
    );
    assert_eq!(w.applied().as_deref(), Some("v1.0.0"));
    // It answers again: the release goes.
    w.remote.borrow_mut().assets_unanswered = false;
    w.round();
    assert_eq!(w.applied().as_deref(), Some("v1.1.0"), "{:?}", w.outcome());
}

/// A new agent's binary in these tests: it answers `self-test`, and nothing else.
fn agent_binary() -> Vec<u8> {
    b"#!/bin/sh\n[ \"$1 $2 $4\" = 'self-test --data-dir --release' ] && { echo ok; exit 0; }\nexit 2\n"
        .to_vec()
}

#[test]
fn a_higher_agent_is_not_taken_from_a_bundle_without_the_co_signature() {
    let me = version::agent();
    for (min_agent, label) in [("0.1.0", "upward"), ("", "only a higher agent reads it")] {
        let mut w = World::running_v1();
        w.install_layout();
        let alice = TestKey::ed25519("alice", 1);
        *w.cosign.borrow_mut() = policy(1, &[&alice]);
        let new = Version(me.0, me.1 + 3, 0);
        let min_agent = if min_agent.is_empty() {
            new.to_string()
        } else {
            min_agent.to_owned()
        };
        publish_agent(
            &w.remote,
            "v1.1.0",
            &Ships {
                version: &new.to_string(),
                min_agent: &min_agent,
                binary: &agent_binary(),
            },
        );
        let detail = refused(&mut w, "v1.1.0", "cosignature");
        assert!(
            detail.contains("v1.1.0's bundle needs 1"),
            "{label}: {detail}"
        );
        assert_eq!(w.agent.exit, None, "{label}");
        assert!(!w.agent.paths.binary(new).exists(), "{label}: downloaded");
        // Co-signed, the agent updates itself first.
        cosign(&w.remote, "v1.1.0", &alice);
        w.round_now();
        assert_eq!(w.agent.exit, Some(0), "{label}: {}", w.journal());
        assert!(w.agent.paths.binary(new).exists(), "{label}");
    }
}

#[test]
fn an_applied_release_s_higher_agent_is_tried_again_only_under_the_co_signature() {
    let me = version::agent();
    let mut w = World::running_v1();
    w.install_layout();
    let new = Version(me.0, me.1 + 3, 0);
    publish_agent(
        &w.remote,
        "v1.1.0",
        &Ships {
            version: &new.to_string(),
            min_agent: "0.1.0",
            binary: b"#!/bin/sh\nexit 1\n",
        },
    );
    // Its self-test fails: this agent applies v1.1.0 itself, and tries the agent again
    // later.
    w.target("v1.1.0", None);
    w.round();
    assert_eq!(w.applied().as_deref(), Some("v1.1.0"), "{:?}", w.outcome());
    assert!(w.agent.retry.is_some());
    // This agent now pins a co-signature v1.1.0 does not carry: after the hour, its agent
    // is not taken, said once.
    let alice = TestKey::ed25519("alice", 1);
    *w.cosign.borrow_mut() = policy(1, &[&alice]);
    w.tick(crate::run::selfupdate::RETRY_S + 1);
    w.poll();
    assert_eq!(w.agent.exit, None);
    assert!(
        w.journal()
            .contains("its agent is not taken: v1.1.0's bundle needs 1 maintainer co-signature(s)"),
        "{}",
        w.journal()
    );
    assert_eq!(w.agent.upward_checked, r("v1.1.0"));
}

#[test]
fn a_rollback_deeper_than_14_days_is_taken_only_with_the_maintainers_co_signature() {
    let mut w = World::running_v1();
    let alice = TestKey::ed25519("alice", 1);
    let bob = TestKey::ecdsa("bob");
    let carol = TestKey::ed25519("carol", 3);
    // Keys pinned, bundles not yet required (threshold 0): a deep rollback needs one.
    *w.cosign.borrow_mut() = policy(0, &[&alice, &bob]);
    w.release("v1.2.0");
    w.target("v1.2.0", None);
    w.round();
    assert_eq!(w.applied().as_deref(), Some("v1.2.0"));

    // v1.0.1 was created 20 days before rollback.yml signed the statement.
    publish(
        &w.remote,
        "v1.0.1",
        "2026-12-26T08:00:00Z",
        "v1.0.0",
        &[],
        "",
    );
    relay_statement(&w.remote, 5, "v1.0.1", "v1.2.0", b"signed");
    assert_eq!(*w.signed_at.borrow(), T0);
    let detail = refused(&mut w, "v1.0.1", "statement-too-deep");
    assert!(
        detail.contains("goes back 20 days, more than the 14 a statement may without 1 maintainer co-signature(s) over it (0 verify)"),
        "{detail}"
    );
    // Carol is pinned by no MAINTAINERS.toml; Alice's signature made for a bundle is not
    // one over a statement.
    cosign_statement(&w.remote, "v1.0.1", &carol);
    refused(&mut w, "v1.0.1", "statement-too-deep");
    {
        let mut s = w.remote.borrow_mut();
        let relayed = s
            .statements
            .get_mut(&Release::parse("v1.0.1").unwrap())
            .unwrap();
        let wrong = alice.sign(BUNDLE_NAMESPACE, &relayed.statement);
        relayed.cosignatures.insert("alice".into(), wrong);
    }
    refused(&mut w, "v1.0.1", "statement-too-deep");
    assert_eq!(w.agent.state.statement_seq, None);
    assert_eq!(w.agent.state.floor, r("v1.2.0"));

    // Alice co-signs the statement: taken, and the journal says by whom.
    cosign_statement(&w.remote, "v1.0.1", &alice);
    w.round();
    assert_eq!(w.applied().as_deref(), Some("v1.0.1"), "{:?}", w.outcome());
    assert_eq!(w.agent.state.floor, r("v1.0.1"));
    assert_eq!(w.agent.state.statement_seq, Some(5));
    let accepted = w
        .journal()
        .lines()
        .find(|l| l.contains("rollback-accepted"))
        .unwrap()
        .to_owned();
    assert!(
        accepted.contains("\"cosigned_by\":[\"alice\"]"),
        "{accepted}"
    );
}

#[test]
fn under_2_of_n_a_co_signed_statement_vouches_for_a_target_published_before_the_threshold() {
    let mut w = World::running_v1();
    let alice = TestKey::ed25519("alice", 1);
    let bob = TestKey::ed25519("bob", 2);
    // v1.0.1 and v1.2.0 were published before the threshold rose: no co-signature asset,
    // and an immutable release takes none later.
    publish(
        &w.remote,
        "v1.0.1",
        "2027-01-14T08:00:00Z",
        "v1.0.0",
        &[],
        "",
    );
    w.release("v1.2.0");
    w.target("v1.2.0", None);
    w.round();
    assert_eq!(w.applied().as_deref(), Some("v1.2.0"));
    *w.cosign.borrow_mut() = policy(2, &[&alice, &bob]);

    // A statement 1 day deep, as rollback.yml signs it: its target lacks the bundle's
    // co-signatures, so the statement must carry them, two of them.
    relay_statement(&w.remote, 1, "v1.0.1", "v1.2.0", b"signed");
    let detail = refused(&mut w, "v1.0.1", "cosignature");
    assert!(detail.contains("v1.0.1's bundle needs 2"), "{detail}");
    cosign_statement(&w.remote, "v1.0.1", &alice);
    refused(&mut w, "v1.0.1", "cosignature");
    assert_eq!(w.agent.state.statement_seq, None);
    cosign_statement(&w.remote, "v1.0.1", &bob);
    w.round();
    assert_eq!(w.applied().as_deref(), Some("v1.0.1"), "{:?}", w.outcome());
    assert_eq!(w.agent.state.floor, r("v1.0.1"));
    // Forward again needs the bundle's own co-signatures: v1.2.0 has none.
    refused(&mut w, "v1.2.0", "cosignature");
}
