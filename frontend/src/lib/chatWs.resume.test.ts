import { beforeEach, expect, it, vi } from "vitest";
import { connectWs } from "./ws";
import { connectChat, type ChatClient } from "./chatWs";

vi.mock("./ws", () => ({ connectWs: vi.fn() }));
const send = vi.fn((_msg: unknown) => true);
beforeEach(() => {
 vi.clearAllMocks();
 vi.mocked(connectWs).mockReturnValue({send,close:vi.fn()});
});
const cursor = {sessionId:"durable",firstEntryId:"a",lastEntryId:"z",historyComplete:true};
const create = {type:"chat.create" as const,wsId:"w",chatId:"c"};
const hello = {type:"hello",version:3,serverVersion:"test"};
const bootstrap = {...create,resume:{sessionId:"",firstEntryId:"",lastEntryId:"",historyComplete:false}};

it.each([false,true])("attaches current coverage only to a rebind (consumer sends=%s)", (consumerSends) => {
 let client: ChatClient | undefined;
 client = connectChat({onFrame:vi.fn(),getHistoryResume:()=>cursor,onOpen:()=>{if(consumerSends) client?.send(create);}});
 const handlers = vi.mocked(connectWs).mock.calls[0]![1];
 handlers.onOpen?.();
 if(!consumerSends) client.send(create);
 handlers.onMessage(hello);
 expect(send.mock.calls.map(call=>call[0])).toContainEqual(bootstrap);
 expect(send.mock.calls.map(call=>call[0])).not.toContainEqual({...create,resume:cursor});
 send.mockClear();
 handlers.onClose?.(1006);
 handlers.onOpen?.();
 handlers.onMessage(hello);
 expect(send.mock.calls.map(call=>call[0]).filter(frame=>typeof frame === "object" && frame !== null && "type" in frame && frame.type==="chat.create")).toEqual([{...create,resume:cursor}]);
 client.send(create);
 expect(send).toHaveBeenLastCalledWith(bootstrap);
 client.close();
});
