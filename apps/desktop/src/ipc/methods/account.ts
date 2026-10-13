import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as DesktopAccount from "../../app/DesktopAccount.ts";
import * as IpcChannels from "../channels.ts";
import * as DesktopIpc from "../DesktopIpc.ts";

const AccountState = Schema.Struct({
  identity: Schema.NullOr(
    Schema.Struct({
      userId: Schema.String,
      email: Schema.NullOr(Schema.String),
      name: Schema.NullOr(Schema.String),
    }),
  ),
});

const SignInResult = Schema.Struct({
  status: Schema.Literals(["signed_in", "cancelled", "failed"]),
  message: Schema.optionalKey(Schema.String),
});

export const getAccountState = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.ACCOUNT_GET_STATE_CHANNEL,
  payload: Schema.Void,
  result: AccountState,
  handler: Effect.fn("desktop.ipc.account.getState")(function* () {
    const account = yield* DesktopAccount.DesktopAccount;
    return yield* Effect.promise(() => account.session.getState());
  }),
});

export const getAccountAccessToken = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.ACCOUNT_GET_ACCESS_TOKEN_CHANNEL,
  payload: Schema.Void,
  result: Schema.NullOr(Schema.String),
  handler: Effect.fn("desktop.ipc.account.getAccessToken")(function* () {
    const account = yield* DesktopAccount.DesktopAccount;
    return yield* Effect.promise(() => account.session.getAccessToken());
  }),
});

export const signInToAccount = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.ACCOUNT_SIGN_IN_CHANNEL,
  payload: Schema.Literals(["sign_in", "sign_up"]),
  result: SignInResult,
  handler: Effect.fn("desktop.ipc.account.signIn")(function* (mode) {
    const account = yield* DesktopAccount.DesktopAccount;
    return yield* Effect.promise(() => account.session.signIn(mode));
  }),
});

export const signOutOfAccount = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.ACCOUNT_SIGN_OUT_CHANNEL,
  payload: Schema.Void,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.account.signOut")(function* () {
    const account = yield* DesktopAccount.DesktopAccount;
    yield* Effect.promise(() => account.session.signOut());
  }),
});

export const openAccountPage = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.ACCOUNT_OPEN_CHANNEL,
  payload: Schema.Void,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.account.open")(function* () {
    const account = yield* DesktopAccount.DesktopAccount;
    yield* Effect.promise(() => account.session.openAccount());
  }),
});
