import { approvalControl } from "./round7-approval.service";

const id="123e4567-e89b-42d3-a456-426614174000";
describe("Round 7 approval control authority",()=>{
  it.each(["/approve"," /approve ","\n/approve\t"])("accepts exact trimmed text %p",text=>expect(approvalControl({kind:"TEXT",text})).toEqual({kind:"TEXT"}));
  it.each(["/Approve","/approve now","x/approve","approve","arbitrary"])("rejects non-exact text %p",text=>expect(approvalControl({kind:"TEXT",text})).toBeNull());
  it("accepts only a canonical bound interactive UUID",()=>expect(approvalControl({kind:"INTERACTIVE",replyId:`newsroom:v1:story:approve:${id}`})).toEqual({kind:"INTERACTIVE",promptId:id}));
  it.each(["newsroom:v1:story:approve:not-a-uuid",`newsroom:v1:story:approve:${id}:suffix`,"newsroom:v1:story:approve:123E4567-E89B-42D3-A456-426614174000","newsroom:v1:story:done"])("rejects malformed or different interaction %p",replyId=>expect(approvalControl({kind:"INTERACTIVE",replyId})).toBeNull());
});
