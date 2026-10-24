// Test-only exact own-session AX body oracle. No activation, capture, input, signal, TCC request or model.
import Foundation
import ApplicationServices
import CoreGraphics
import CryptoKit
import Darwin
private struct Failure: Error { let code: String }
private func check(_ value: Bool, _ code: String) throws { if !value { throw Failure(code: code) } }
private struct ProcessPin: Codable, Equatable { let pid: Int32; let birthMicros: String; let executable: String; let parentPID: Int32; let sha256: String }
private struct Frame: Codable, Equatable { let x: Double; let y: Double; let width: Double; let height: Double; var rect: CGRect { CGRect(x:x,y:y,width:width,height:height) } }
private struct Pin: Codable { let profileRoot: String; let host: ProcessPin; let target: ProcessPin; let runnerPID: Int32; let windowID: UInt32; let title: String; let frame: Frame }
private struct Request: Decodable { let op: String; let profileRoot: String?; let hostPID: Int32?; let runnerPID: Int32?; let targetPID: Int32?; let windowID: UInt32?; let title: String?; let frame: Frame?; let binding: Pin?; let budgetMs: Int? }
private let sessionSHA = "0000000000000000000000000000000000000000000000000000000000000000"
private let hostSHA = "0000000000000000000000000000000000000000000000000000000000000000"
private let hostExecutable = "/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness"
private func canonical(_ path: String) throws -> String {
 try check(path.hasPrefix("/") && !path.contains("\0"),"canonical-path-unavailable")
 guard let resolved=Darwin.realpath(path,nil) else {throw Failure(code:"canonical-path-unavailable")}
 defer {free(resolved)};return String(cString:resolved)
}
private func profileScope(_ path: String) throws {
 let root=URL(fileURLWithPath:path),parent=root.deletingLastPathComponent().lastPathComponent
 try check(try canonical(path) == path && root.lastPathComponent == "qiuya-harness-home" && parent.range(of:"^qiuya-harness-e2e-[A-Za-z0-9_-]+$",options:.regularExpression) != nil,"own-profile-required")
}
private func hash(_ data: Data) -> String { SHA256.hash(data:data).map { String(format:"%02x",$0) }.joined() }
private func process(_ pid: Int32, hashing: Bool = true) throws -> ProcessPin {
 var info = proc_bsdinfo(); try check(pid > 1 && proc_pidinfo(pid,PROC_PIDTBSDINFO,0,&info,Int32(MemoryLayout<proc_bsdinfo>.size)) == MemoryLayout<proc_bsdinfo>.size && info.pbi_uid == getuid(),"owned-process-unavailable")
 var path=[CChar](repeating:0,count:4096);try check(proc_pidpath(pid,&path,UInt32(path.count)) > 0,"owned-executable-unavailable")
 let executable=try canonical(String(cString:path)), bytes=hashing ? try Data(contentsOf:URL(fileURLWithPath:executable),options:.mappedIfSafe) : Data()
 return ProcessPin(pid:pid,birthMicros:String(info.pbi_start_tvsec * 1_000_000 + info.pbi_start_tvusec),executable:executable,parentPID:Int32(info.pbi_ppid),sha256:hashing ? hash(bytes) : "")
}
private func sameProcess(_ actual: ProcessPin, _ expected: ProcessPin, hashing: Bool = true) -> Bool { actual.pid == expected.pid && actual.birthMicros == expected.birthMicros && actual.executable == expected.executable && actual.parentPID == expected.parentPID && (!hashing || actual.sha256 == expected.sha256) }
private func rows() -> [[String:Any]] { CGWindowListCopyWindowInfo([.optionOnScreenOnly,.excludeDesktopElements],kCGNullWindowID) as? [[String:Any]] ?? [] }
private func close(_ a: CGRect,_ b: CGRect) -> Bool { abs(a.minX-b.minX)<1 && abs(a.minY-b.minY)<1 && abs(a.width-b.width)<1 && abs(a.height-b.height)<1 }
private func window(_ pin: Pin) throws {
 let matching=rows().filter { ($0[kCGWindowNumber as String] as? NSNumber)?.uint32Value == pin.windowID && ($0[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value == pin.target.pid }
 try check(matching.count == 1,"exact-window-unavailable");let value=matching[0]
 guard let b=value[kCGWindowBounds as String] as? [String:Any],let r=CGRect(dictionaryRepresentation:b as CFDictionary) else { throw Failure(code:"exact-window-geometry-unavailable") }
 try check(close(r,pin.frame.rect) && value[kCGWindowName as String] as? String == pin.title && (value[kCGWindowAlpha as String] as? NSNumber)?.doubleValue ?? 0 > 0,"exact-window-changed")
}
private func validate(_ pin: Pin, hashing: Bool = true) throws {
 try profileScope(pin.profileRoot)
 let expected=try canonical(pin.profileRoot+"/profiles/web/node_modules/dsh-qiuya-tools/lib/QiuYaTools Sessions.app/Contents/MacOS/qiuya-session-window")
 try check(pin.target.executable == expected && pin.target.sha256 == sessionSHA && pin.host.executable == (try canonical(hostExecutable)) && pin.host.sha256 == hostSHA && pin.target.parentPID == pin.host.pid && pin.host.parentPID == pin.runnerPID && pin.runnerPID > 1,"own-process-binding-invalid")
 try check(sameProcess(try process(pin.host.pid,hashing:hashing),pin.host,hashing:hashing) && sameProcess(try process(pin.target.pid,hashing:hashing),pin.target,hashing:hashing),"own-process-changed")
 try window(pin)
}
private struct Candidate { let index: Int; let number: UInt32?; let title: String; let frame: CGRect; let pid: Int32 }
private func select(_ candidates:[Candidate],number:UInt32,title:String,frame:CGRect,pid:Int32) throws -> (Int,String) {
 let exact=candidates.filter { $0.number == number && $0.pid == pid && $0.title == title && close($0.frame,frame) }
 if !exact.isEmpty { try check(exact.count == 1,"ax-number-not-unique");return(exact[0].index,"advertised-window-number") }
 let matching=candidates.filter { $0.pid == pid && $0.title == title && close($0.frame,frame) }
 try check(matching.count == 1 && matching[0].number == nil,"ax-window-not-uniquely-confirmed")
 return(matching[0].index,"unique-exact-title-and-geometry-no-advertised-number")
}
private func body(_ pin: Pin, budgetMs: Int) throws -> [String:Any] {
 try validate(pin);try check(AXIsProcessTrusted(),"accessibility-not-granted")
 let started=DispatchTime.now().uptimeNanoseconds, deadline=started+UInt64(budgetMs)*1_000_000
 var incomplete=false,visited:[AXUIElement]=[],texts:[String]=[],nodes=0,maxDepth=0
 func fence() throws { try check(DispatchTime.now().uptimeNanoseconds < deadline,"ax-read-budget");try check(sameProcess(try process(pin.target.pid,hashing:false),pin.target,hashing:false) && sameProcess(try process(pin.host.pid,hashing:false),pin.host,hashing:false),"own-process-changed");try check(DispatchTime.now().uptimeNanoseconds < deadline,"ax-read-budget") }
 func attribute(_ element:AXUIElement,_ key:String) throws -> CFTypeRef? {
  try fence();let instant=DispatchTime.now().uptimeNanoseconds;try check(instant < deadline,"ax-read-budget");AXUIElementSetMessagingTimeout(element,Float(min(0.05,Double(deadline-instant)/1_000_000_000)))
  var value:CFTypeRef?;let code=AXUIElementCopyAttributeValue(element,key as CFString,&value);try fence()
  if code == .cannotComplete || code == .invalidUIElement { incomplete=true };return code == .success ? value : nil
 }
 func frame(_ element:AXUIElement) throws -> CGRect? {
  guard let p=try attribute(element,kAXPositionAttribute),let s=try attribute(element,kAXSizeAttribute),CFGetTypeID(p) == AXValueGetTypeID(),CFGetTypeID(s) == AXValueGetTypeID() else { return nil }
  var point=CGPoint.zero,size=CGSize.zero
  guard AXValueGetValue(p as! AXValue,.cgPoint,&point),AXValueGetValue(s as! AXValue,.cgSize,&size) else { return nil };return CGRect(origin:point,size:size)
 }
 let application=AXUIElementCreateApplication(pin.target.pid)
 guard let windows=try attribute(application,kAXWindowsAttribute) as? [AXUIElement] else { throw Failure(code:"own-ax-windows-unavailable") }
 try check(windows.count <= 32,"own-ax-window-limit");var candidates:[Candidate]=[]
 for(index,element)in windows.enumerated(){var pid:pid_t=0;try check(AXUIElementGetPid(element,&pid) == .success && pid == pin.target.pid,"own-ax-pid-mismatch")
  guard let rect=try frame(element),let title=try attribute(element,kAXTitleAttribute) as? String else { continue }
  // Query only attributes advertised by this AX provider. No private SPI/function or assumed window-number support.
  try fence();var advertised:CFArray?;let code=AXUIElementCopyAttributeNames(element,&advertised);try fence();var number:UInt32?
  if code == .success,let names=advertised as? [String],let key=["AXWindowNumber","AXWindowID"].first(where:names.contains),let n=try attribute(element,key) as? NSNumber { let value=n.int64Value;if value > 0 && value <= Int64(UInt32.max){number=UInt32(value)} }
  candidates.append(Candidate(index:index,number:number,title:title,frame:rect,pid:pid))
 }
 let choice=try select(candidates,number:pin.windowID,title:pin.title,frame:pin.frame.rect,pid:pin.target.pid),root=windows[choice.0]
 func walk(_ element:AXUIElement,_ depth:Int) throws {
  try fence();if visited.contains(where:{CFEqual($0,element)}){return};visited.append(element);if depth >= 32 || nodes >= 768 {incomplete=true;return};nodes+=1;maxDepth=max(maxDepth,depth)
  let role=try attribute(element,kAXRoleAttribute) as? String ?? "",secure=(try attribute(element,kAXSubroleAttribute) as? String) == "AXSecureTextField"
  for key in secure ? [kAXTitleAttribute,kAXDescriptionAttribute] : [kAXTitleAttribute,kAXDescriptionAttribute,kAXValueAttribute] {
   if let value=try attribute(element,key) as? String,!value.isEmpty {if value.utf8.count > 2048 {incomplete=true};texts.append(role+" | "+String(value.prefix(2048)));if texts.joined(separator:"\n").utf8.count > 30000 {incomplete=true;return}}
  }
  if let children=try attribute(element,kAXChildrenAttribute) as? [AXUIElement] {if children.count > 128{incomplete=true};for child in children.prefix(128){try walk(child,depth+1)}}
 }
 try walk(root,0);try fence();try validate(pin);try fence();let text=texts.joined(separator:"\n");try check(!incomplete,"own-ax-body-incomplete")
 return["binding":try object(pin),"text":text,"textSHA256":hash(Data(text.utf8)),"complete":true,"nodes":nodes,"maximumDepth":maxDepth,"elapsedMs":Double(DispatchTime.now().uptimeNanoseconds-started)/1_000_000,"selection":choice.1,"AXRealCalls":true,"inputEventsPosted":0,"captureCalls":0,"signalsSent":0]
}
private func object<T:Encodable>(_ value:T)throws -> Any {try JSONSerialization.jsonObject(with:JSONEncoder().encode(value))}
private func pure()throws -> [String:Any] {
 let rect=CGRect(x:1,y:2,width:100,height:80),first=Candidate(index:0,number:nil,title:"own",frame:rect,pid:42),other=Candidate(index:1,number:nil,title:"own",frame:rect,pid:42)
 try check(try select([first],number:7,title:"own",frame:rect,pid:42).0 == 0,"pure-unique")
 do{_ = try select([first,other],number:7,title:"own",frame:rect,pid:42);throw Failure(code:"pure-ambiguous-accepted")}catch let e as Failure{try check(e.code == "ax-window-not-uniquely-confirmed","pure-ambiguity")}
 let numbered=Candidate(index:2,number:7,title:"own",frame:rect,pid:42);try check(try select([first,numbered],number:7,title:"own",frame:rect,pid:42).0 == 2,"pure-number")
 do{_ = try select([Candidate(index:0,number:8,title:"own",frame:rect,pid:42)],number:7,title:"own",frame:rect,pid:42);throw Failure(code:"pure-wrong-number-accepted")}catch let e as Failure{try check(e.code == "ax-window-not-uniquely-confirmed","pure-wrong-number")}
 return["passed":true,"cases":4,"actualAXCalls":0,"actualProcessQueries":0,"inputEventsPosted":0,"captureCalls":0,"signalsSent":0]
}
@main private struct Main {
 static func main(){do{
  if CommandLine.arguments == [CommandLine.arguments[0],"--self-test"] {print(String(data:try JSONSerialization.data(withJSONObject:try pure(),options:.sortedKeys),encoding:.utf8)!);return}
  if CommandLine.arguments.count == 3 && CommandLine.arguments[1] == "--self-test-own-path" {
   try profileScope(CommandLine.arguments[2]);print(String(data:try JSONSerialization.data(withJSONObject:["ok":true,"canonical":try canonical(CommandLine.arguments[2]),"actualAXCalls":0,"actualProcessQueries":0,"inputEventsPosted":0,"captureCalls":0,"signalsSent":0],options:.sortedKeys),encoding:.utf8)!);return
  }
  let supplied = CommandLine.arguments.count == 3 && CommandLine.arguments[1] == "--request-json" ? CommandLine.arguments[2] : readLine()
  guard let line=supplied,line.utf8.count<=16384,let data=line.data(using:.utf8),let raw=try JSONSerialization.jsonObject(with:data)as?[String:Any] else{throw Failure(code:"invalid-request")}
  let op=raw["op"]as?String,keys=op == "bind" ? ["op","profileRoot","hostPID","runnerPID","targetPID","windowID","title","frame"] : ["op","binding","budgetMs"]
  try check(Set(raw.keys).isSubset(of:Set(keys)),"invalid-request");let request=try JSONDecoder().decode(Request.self,from:data),result:[String:Any]
  if request.op == "bind" {guard let root=request.profileRoot,let host=request.hostPID,let runner=request.runnerPID,let target=request.targetPID,let window=request.windowID,let title=request.title,let frame=request.frame else{throw Failure(code:"binding-required")}
   try check(title.range(of:"^E2E:(Alpha|Beta)-[A-Za-z0-9]+ — QiuYaTools$",options:.regularExpression) != nil && frame.width > 100 && frame.height > 100,"own-nonce-required")
   let pin=Pin(profileRoot:root,host:try process(host),target:try process(target),runnerPID:runner,windowID:window,title:title,frame:frame);try validate(pin);result=["binding":try object(pin),"inputEventsPosted":0,"captureCalls":0,"signalsSent":0]
  }else if request.op == "observe",let pin=request.binding,let budget=request.budgetMs,budget >= 1 && budget <= 1500 {result=try body(pin,budgetMs:budget)}else{throw Failure(code:"invalid-request")}
  print(String(data:try JSONSerialization.data(withJSONObject:["ok":true,"value":result],options:.sortedKeys),encoding:.utf8)!)
 }catch{let code=(error as?Failure)?.code ?? "readonly-oracle-failed";print(String(data:try! JSONSerialization.data(withJSONObject:["ok":false,"code":code,"inputEventsPosted":0,"captureCalls":0,"signalsSent":0],options:.sortedKeys),encoding:.utf8)!)} }
}
