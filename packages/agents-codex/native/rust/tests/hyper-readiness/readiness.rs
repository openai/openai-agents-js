//! Public HTTP1 regressions for stale readiness and an observed send grant.
use std::future::{Future, poll_fn};
use std::io;
use std::pin::Pin;
use std::sync::{
    Arc,
    atomic::{AtomicUsize, Ordering},
};
use std::task::{Context, Poll};

use bytes::Bytes;
use http_body_util::Empty;
use hyper::Request;
use hyper::client::conn::http1::{self, Connection, SendRequest};
use hyper::rt::{Read, ReadBufCursor, Write};

struct NoReply(Arc<AtomicUsize>);
impl Read for NoReply {
    fn poll_read(
        self: Pin<&mut Self>,
        _: &mut Context<'_>,
        _: ReadBufCursor<'_>,
    ) -> Poll<io::Result<()>> {
        Poll::Pending
    }
}
impl Write for NoReply {
    fn poll_write(
        self: Pin<&mut Self>,
        _: &mut Context<'_>,
        bytes: &[u8],
    ) -> Poll<io::Result<usize>> {
        self.0.fetch_add(bytes.len(), Ordering::Relaxed);
        Poll::Ready(Ok(bytes.len()))
    }
    fn poll_flush(self: Pin<&mut Self>, _: &mut Context<'_>) -> Poll<io::Result<()>> {
        Poll::Ready(Ok(()))
    }
    fn poll_shutdown(self: Pin<&mut Self>, _: &mut Context<'_>) -> Poll<io::Result<()>> {
        Poll::Ready(Ok(()))
    }
}
type Driver = Connection<NoReply, Empty<Bytes>>;

async fn setup() -> (SendRequest<Empty<Bytes>>, Driver, Arc<AtomicUsize>) {
    let written = Arc::new(AtomicUsize::new(0));
    let (sender, mut driver) = http1::handshake(NoReply(written.clone())).await.unwrap();
    poll_fn(|cx| {
        assert!(Pin::new(&mut driver).poll(cx).is_pending());
        Poll::Ready(())
    })
    .await;
    assert!(sender.is_ready());
    (sender, driver, written)
}

fn exhaust_budget(cx: &mut Context<'_>) {
    for _ in 0..1024 {
        match tokio::task::coop::poll_proceed(cx) {
            Poll::Ready(credit) => credit.made_progress(),
            Poll::Pending => return,
        }
    }
    panic!("expected a finite Tokio cooperative budget");
}

#[tokio::test(flavor = "current_thread")]
async fn queued_request_does_not_leave_busy_sender_ready() {
    let (mut sender, mut driver, written) = setup().await;
    let retained_response = sender.send_request(Request::new(Empty::new()));
    assert!(!sender.is_ready());
    poll_fn(|cx| {
        exhaust_budget(cx);
        assert!(Pin::new(&mut driver).poll(cx).is_pending());
        Poll::Ready(())
    })
    .await;
    tokio::task::yield_now().await;
    poll_fn(|cx| {
        let mut unrestricted = std::pin::pin!(tokio::task::unconstrained(Pin::new(&mut driver)));
        assert!(unrestricted.as_mut().poll(cx).is_pending());
        Poll::Ready(())
    })
    .await;
    assert!(
        written.load(Ordering::Relaxed) > 0,
        "first request reached the transport"
    );
    assert!(
        !sender.is_ready(),
        "in-flight request cannot make the sender idle"
    );
    drop(retained_response);
}

#[tokio::test(flavor = "current_thread")]
async fn driver_progress_cannot_retract_an_observed_send_grant() {
    let (mut sender, mut driver, _written) = setup().await;
    let retained_response = sender.send_request(Request::new(Empty::new()));
    poll_fn(|cx| {
        exhaust_budget(cx);
        assert!(Pin::new(&mut driver).poll(cx).is_pending());
        match sender.poll_ready(cx) {
            Poll::Pending => return Poll::Ready(()),
            Poll::Ready(result) => result.unwrap(),
        }
        let mut unrestricted = std::pin::pin!(tokio::task::unconstrained(Pin::new(&mut driver)));
        assert!(unrestricted.as_mut().poll(cx).is_pending());
        assert!(!sender.is_closed());
        let mut subsequent = std::pin::pin!(sender.send_request(Request::new(Empty::new())));
        assert!(
            subsequent.as_mut().poll(cx).is_pending(),
            "a live readiness grant must allow enqueue"
        );
        Poll::Ready(())
    })
    .await;
    drop(retained_response);
}
