#include <node.h>
#include <v8.h>

static_assert(NODE_MODULE_VERSION == AGENTS_NODE_ABI, "Mismatched Node headers");

namespace {
using v8::Function;
using v8::Local;
using v8::Object;
using v8::Value;

void ReadSaved(Local<v8::Name>, const v8::PropertyCallbackInfo<Value>& info) {
  auto isolate = info.GetIsolate();
  Local<Value> result;
  if (info.Data().As<Function>()->Call(isolate->GetCurrentContext(),
          v8::Undefined(isolate), 0, nullptr).ToLocal(&result)) {
    info.GetReturnValue().Set(result);
  }
}

void InstallSaved(const v8::FunctionCallbackInfo<Value>& args) {
  if (args.Length() != 3 || !args[0]->IsObject() || args[0]->IsProxy() ||
      !args[1]->IsString() || !args[2]->IsFunction()) return;
  auto installed = args[0].As<Object>()->SetLazyDataProperty(
      args.GetIsolate()->GetCurrentContext(), args[1].As<v8::Name>(),
      ReadSaved, args[2]);
  if (!installed.IsNothing()) args.GetReturnValue().Set(installed.FromJust());
}

void CloneEnvelope(const v8::FunctionCallbackInfo<Value>& args) {
  if (args.Length() != 1 || !args[0]->IsObject() || args[0]->IsProxy()) return;
  args.GetReturnValue().Set(args[0].As<Object>()->Clone());
}

void IsLazyEnvelope(const v8::FunctionCallbackInfo<Value>& args) {
  args.GetReturnValue().Set(false);
  if (args.Length() != 2 || !args[0]->IsObject() || args[0]->IsProxy() ||
      !args[1]->IsString()) return;
  auto result = args[0].As<Object>()->HasRealNamedCallbackProperty(
      args.GetIsolate()->GetCurrentContext(), args[1].As<v8::Name>());
  if (!result.IsNothing()) args.GetReturnValue().Set(result.FromJust());
}

int StartupScript(v8::Isolate* isolate, Local<Value> value,
                  const char* resource, const char* name) {
  if (!value->IsFunction() || value->IsProxy()) return -1;
  auto fn = value.As<Function>();
  Local<v8::Context> owner;
  if (!fn->GetBoundFunction()->IsUndefined() ||
      !fn->GetCreationContext().ToLocal(&owner) ||
      owner != isolate->GetCurrentContext()) return -1;
  auto origin = fn->GetScriptOrigin().ResourceName();
  if (origin.IsEmpty() || !origin->StrictEquals(
          v8::String::NewFromUtf8(isolate, resource).ToLocalChecked()) ||
      !fn->GetName()->StrictEquals(
          v8::String::NewFromUtf8(isolate, name).ToLocalChecked())) return -1;
  return fn->ScriptId();
}

// Stock Node loads clone support before these startup modules. Comparing their
// dynamic origins rejects later clone wrappers without invoking a candidate.
// The anchors must themselves come from stock Node; custom startup order or
// replacement anchors remain outside this optional accelerator's guarantee.
void StockClone(const v8::FunctionCallbackInfo<Value>& args) {
  args.GetReturnValue().Set(false);
  if (args.Length() != 3) return;
  auto isolate = args.GetIsolate();
  const int clone = StartupScript(isolate, args[0],
      "node:internal/worker/js_transferable", "structuredClone");
  const int ticks = StartupScript(isolate, args[1],
      "node:internal/process/task_queues", "nextTick");
  const int timers = StartupScript(isolate, args[2], "node:timers", "setTimeout");
  args.GetReturnValue().Set(clone >= 0 && clone < ticks && clone < timers);
}

void SameShape(const v8::FunctionCallbackInfo<Value>& args) {
  args.GetReturnValue().Set(false);
  if (args.Length() != 2 || !args[0]->IsObject() || args[0]->IsProxy() ||
      !args[1]->IsObject() || args[1]->IsProxy()) return;
  v8::TypecheckWitness witness(args.GetIsolate());
  witness.Update(args[0]);
  args.GetReturnValue().Set(witness.Matches(args[1]));
}

void Classify(const v8::FunctionCallbackInfo<Value>& args) {
  args.GetReturnValue().Set(-1);
  if (!args.Length() || !args[0]->IsObject() || args[0]->IsProxy()) return;
  v8::TypecheckWitness witness(args.GetIsolate());
  witness.Update(args[0]);
  for (int index = 1; index < args.Length(); index++) {
    if (args[index]->IsObject() && !args[index]->IsProxy() &&
        witness.Matches(args[index])) {
      args.GetReturnValue().Set(index - 1);
      return;
    }
  }
}
}  // namespace

NODE_MODULE_INIT() {
  NODE_SET_METHOD(exports, "stockClone", StockClone);
  NODE_SET_METHOD(exports, "installSaved", InstallSaved);
  NODE_SET_METHOD(exports, "isLazyEnvelope", IsLazyEnvelope);
  NODE_SET_METHOD(exports, "cloneEnvelope", CloneEnvelope);
  NODE_SET_METHOD(exports, "sameShape", SameShape);
  NODE_SET_METHOD(exports, "classify", Classify);
}
