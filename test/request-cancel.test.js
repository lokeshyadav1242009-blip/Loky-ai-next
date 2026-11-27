/**
 * Regression tests for the outgoing friend-request cancellation bug.
 *
 * Reported bug: pressing Cancel on a sent request did not remove the person
 * from the Sent list. Root cause is a contract mismatch, not a UI slip:
 *
 *   - public.my_friend_requests() returns EVERY request involving the user,
 *     with no status filter.
 *   - public.cancel_friend_request() marks the row 'cancelled'/'cancelled'
 *     (status = 'cancelled') instead of deleting it.
 *   - renderRequests() therefore re-rendered the cancelled row on the next
 *     refresh, so the request looked like it was still pending.
 *
 * These tests pin the two things that make Cancel actually stick:
 *   1. only still-pending rows may be listed (splitPendingRequests), and
 *   2. cancelRequest() drops the row locally before the refresh re-reads it.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
