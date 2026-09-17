import * as pdfjsLib from "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.10.38/pdf.min.mjs";
pdfjsLib.GlobalWorkerOptions.workerSrc = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.10.38/pdf.worker.min.mjs";

const $ = (id) => document.getElementById(id);
const COLORS = {1829:"#1684f8",1524:"#00a88f",1219:"#6f63e8",914:"#e88b18",610:"#dd4e68"};
const BASE_SCALE = 1.25;
const KEY = "ashiba-hayami-v1";
let blocks = [], history = [], future = [], selectedId = null, tool = "add";
let span = 1829, width = 610, defaultHeight = 7600, drawingScale = 100, mmPerPx = 28.222, zoom = 1;
let pdfDoc = null, pageNumber = 1, pageCount = 0, baseStage = {width:1120,height:760};
let calibrationPoints = [], drag = null, renderTask = null;

const stage = $("stage"), layer = $("blocksLayer"), calLayer = $("calibrationLayer"), canvas = $("pdfCanvas");
const uid = () => Date.now().toString(36)+"-"+Math.random().toString(36).slice(2,8);
const status = (message) => {$("status").textContent=message;$("ratio").textContent=mmPerPx.toFixed(2)+" mm / px"};
const saveLocal = () => localStorage.setItem(KEY,JSON.stringify({blocks,mmPerPx,drawingScale}));
const setTool = (next) => {
  tool=next; stage.className="drawing-stage tool-"+next;
  $("selectMode").classList.toggle("active",next==="select");
  $("placeMode").classList.toggle("active",next==="add");
  $("calibrate").classList.toggle("primary",next==="calibrate");
};
const commit = (next) => {history=[...history.slice(-39),structuredClone(blocks)];future=[];blocks=next;saveLocal();renderBlocks();updateSummary()};
const point = (event) => {const rect=stage.getBoundingClientRect();return{x:(event.clientX-rect.left)/zoom,y:(event.clientY-rect.top)/zoom}};
const dimensions = (b) => ({w:(b.rotation===0?b.span:b.width)/mmPerPx,h:(b.rotation===0?b.width:b.span)/mmPerPx});
const corners = (b) => {const {w,h}=dimensions(b);return[[b.x,b.y],[b.x+w,b.y],[b.x,b.y+h],[b.x+w,b.y+h]]};
const overlapArea = (a,b) => {
  const ad=dimensions(a),bd=dimensions(b);
  return Math.max(0,Math.min(a.x+ad.w,b.x+bd.w)-Math.max(a.x,b.x))*Math.max(0,Math.min(a.y+ad.h,b.y+bd.h)-Math.max(a.y,b.y));
};
function snapBlock(candidate,excludeId=null){
  const threshold=18/zoom,candidateCorners=corners(candidate);let best=null;
  blocks.filter(b=>b.id!==excludeId).forEach(other=>{
    corners(other).forEach(target=>candidateCorners.forEach(source=>{
      const dx=target[0]-source[0],dy=target[1]-source[1],distance=Math.hypot(dx,dy);
      if(distance>threshold||best&&distance>=best.distance)return;
      const snapped={...candidate,x:Math.max(0,candidate.x+dx),y:Math.max(0,candidate.y+dy)};
      if(overlapArea(snapped,other)>1)return;
      best={block:snapped,distance};
    }));
  });
  return best?{block:best.block,snapped:true}:{block:candidate,snapped:false};
}

async function loadPdf(file){
  try{
    status("PDFを読み込んでいます…");
    pdfDoc=await pdfjsLib.getDocument({data:new Uint8Array(await file.arrayBuffer())}).promise;
    pageCount=pdfDoc.numPages;pageNumber=1;$("pdfName").textContent=file.name;$("pdfHelp").textContent=pageCount+"ページ";
    $("pageNav").classList.toggle("hidden",pageCount<2);mmPerPx=drawingScale*(25.4/72)/BASE_SCALE;
    await renderPdf();status(file.name+" を読み込みました");
  }catch(error){console.error(error);status("PDFを読み込めませんでした。別のPDFでお試しください")}
}
async function renderPdf(){
  if(!pdfDoc)return;
  try{renderTask?.cancel?.()}catch{}
  const page=await pdfDoc.getPage(pageNumber),base=page.getViewport({scale:BASE_SCALE}),view=page.getViewport({scale:BASE_SCALE*zoom});
  baseStage={width:base.width,height:base.height};setStageSize();
  const ratio=window.devicePixelRatio||1,ctx=canvas.getContext("2d");
  canvas.width=Math.floor(view.width*ratio);canvas.height=Math.floor(view.height*ratio);canvas.style.width=view.width+"px";canvas.style.height=view.height+"px";
  ctx.setTransform(ratio,0,0,ratio,0,0);renderTask=page.render({canvasContext:ctx,viewport:view});await renderTask.promise;
  canvas.classList.add("visible");$("emptyPlan").classList.add("hidden");$("pageLabel").textContent=pageNumber+" / "+pageCount;
}
function setStageSize(){stage.style.width=baseStage.width*zoom+"px";stage.style.height=baseStage.height*zoom+"px";renderBlocks();renderCalibration()}
function renderBlocks(){
  layer.innerHTML="";
  blocks.forEach((b,index)=>{
    const w=(b.rotation===0?b.span:b.width)/mmPerPx,h=(b.rotation===0?b.width:b.span)/mmPerPx;
    const el=document.createElement("button");el.className="scaffold-block"+(b.id===selectedId?" selected":"");el.dataset.id=b.id;
    Object.assign(el.style,{left:b.x*zoom+"px",top:b.y*zoom+"px",width:w*zoom+"px",height:h*zoom+"px",borderColor:COLORS[b.span],backgroundColor:COLORS[b.span]+"30","--c":COLORS[b.span]});
    el.innerHTML="<span>"+(index+1)+"</span>"+(w*zoom>58?"<small>"+b.span+"</small>":"")+'<i class="post-dot tl"></i><i class="post-dot tr"></i><i class="post-dot bl"></i><i class="post-dot br"></i>';
    el.addEventListener("pointerdown",(e)=>{e.stopPropagation();selectBlock(b.id);setTool("select");const p=point(e);history=[...history.slice(-39),structuredClone(blocks)];future=[];drag={id:b.id,dx:p.x-b.x,dy:p.y-b.y};el.setPointerCapture(e.pointerId)});
    el.addEventListener("click",(e)=>e.stopPropagation());layer.appendChild(el);
  });
  $("undo").disabled=!history.length;$("redo").disabled=!future.length;
}
function renderCalibration(){calLayer.innerHTML="";calibrationPoints.forEach((p,i)=>{const el=document.createElement("span");el.className="cal-point";el.style.left=p.x*zoom+"px";el.style.top=p.y*zoom+"px";el.textContent=i+1;calLayer.appendChild(el)})}
function selectBlock(id){
  selectedId=id;renderBlocks();const b=blocks.find(v=>v.id===id);
  $("selectionEmpty").classList.toggle("hidden",!!b);$("selectionEditor").classList.toggle("hidden",!b);
  $("selectionBadge").textContent=b?"No."+(blocks.findIndex(v=>v.id===id)+1):"未選択";
  if(b){$("selectedColor").style.background=COLORS[b.span];$("selectedSpec").textContent=b.span+" × "+b.width;$("selectedHeight").value=b.height;$("selectedLevels").textContent=Math.ceil(b.height/1900)+"段"}
}
function updateSummary(){
  const length=blocks.reduce((s,b)=>s+b.span,0)/1000,area=blocks.reduce((s,b)=>s+b.span/1000*b.height/1000,0);
  $("metricCount").textContent=blocks.length;$("metricLength").textContent=length.toFixed(1);$("metricArea").textContent=area.toFixed(1);
  const rows=quantities();$("csv").disabled=!rows.length;
  $("quantityBody").innerHTML=rows.length?rows.map(r=>`<tr><td>${r[0]}<small>${r[1]}</small></td><td><strong>${r[2].toLocaleString()}</strong> ${r[3]}</td></tr>`).join(""):'<tr><td colspan="2" class="zero">足場を配置すると集計します</td></tr>';
}
function quantities(){
  if(!blocks.length)return[];
  const levels=b=>Math.max(1,Math.ceil(b.height/1900)),totalLevels=blocks.reduce((s,b)=>s+levels(b),0),points=new Set();
  blocks.forEach(b=>{const w=(b.rotation===0?b.span:b.width)/mmPerPx,h=(b.rotation===0?b.width:b.span)/mmPerPx;[[b.x,b.y],[b.x+w,b.y],[b.x,b.y+h],[b.x+w,b.y+h]].forEach(([x,y])=>points.add(Math.round(x/4)+","+Math.round(y/4)))});
  const maxLevels=Math.max(...blocks.map(levels)),decks=blocks.reduce((s,b)=>s+levels(b)*Math.max(1,Math.ceil(b.width/500)),0);
  const length=blocks.reduce((s,b)=>s+b.span,0)/1000,maxHeight=Math.max(...blocks.map(b=>b.height))/1000;
  return [["支柱","1,900mm相当",points.size*maxLevels,"本"],["ジャッキベース","標準",points.size,"本"],["布材","スパン別概算",totalLevels*2,"本"],["腕木","足場幅別概算",totalLevels*2,"本"],["鋼製踏板","500幅換算",decks,"枚"],["先行手すり","外側",totalLevels,"枚"],["幅木","外側",totalLevels,"枚"],["壁つなぎ","8m×9m目安",Math.max(1,Math.ceil(length/8)*Math.ceil(maxHeight/9)),"本"]];
}
function download(name,content,type){const url=URL.createObjectURL(new Blob([content],{type})),a=document.createElement("a");a.href=url;a.download=name;a.click();URL.revokeObjectURL(url)}

$("pdfInput").addEventListener("change",e=>e.target.files[0]&&loadPdf(e.target.files[0]));
document.querySelector(".pdf-drop").addEventListener("dragover",e=>e.preventDefault());
document.querySelector(".pdf-drop").addEventListener("drop",e=>{e.preventDefault();const f=e.dataTransfer.files[0];if(f?.type==="application/pdf")loadPdf(f)});
$("prevPage").onclick=async()=>{if(pageNumber>1){pageNumber--;await renderPdf()}};
$("nextPage").onclick=async()=>{if(pageNumber<pageCount){pageNumber++;await renderPdf()}};
$("drawingScale").onchange=e=>{drawingScale=Number(e.target.value);mmPerPx=drawingScale*(25.4/72)/BASE_SCALE;calibrationPoints=[];saveLocal();renderBlocks();renderCalibration();status("図面縮尺を 1/"+drawingScale+" に設定しました")};
$("calibrate").onclick=()=>{calibrationPoints=[];setTool("calibrate");renderCalibration();status("図面上の基準寸法の両端をクリックしてください")};
document.querySelectorAll("[data-span]").forEach(el=>el.onclick=()=>{document.querySelectorAll("[data-span]").forEach(v=>v.classList.remove("active"));el.classList.add("active");span=Number(el.dataset.span);setTool("add")});
$("scaffoldWidth").onchange=e=>width=Number(e.target.value);$("defaultHeight").onchange=e=>defaultHeight=Number(e.target.value);
$("addMode").onclick=$("placeMode").onclick=()=>setTool("add");$("selectMode").onclick=()=>setTool("select");
stage.addEventListener("click",e=>{
  const p=point(e);
  if(tool==="calibrate"){calibrationPoints=[...calibrationPoints,p].slice(-2);renderCalibration();if(calibrationPoints.length===2){const px=Math.hypot(calibrationPoints[1].x-calibrationPoints[0].x,calibrationPoints[1].y-calibrationPoints[0].y),known=Number($("knownLength").value);if(px>2&&known>0){mmPerPx=known/px;saveLocal();renderBlocks();status("基準寸法 "+known.toLocaleString()+"mm で補正しました");setTool("add")}}return}
  if(tool!=="add"){selectBlock(null);return}
  const w=span/mmPerPx,d=width/mmPerPx,raw={id:uid(),x:Math.max(0,p.x-w/2),y:Math.max(0,p.y-d/2),span,width,height:defaultHeight,rotation:0};
  const result=snapBlock(raw),b=result.block;
  commit([...blocks,b]);selectBlock(b.id);status(result.snapped?"支柱位置に吸着して配置しました":span+"mmスパンを配置しました");
});
stage.addEventListener("pointermove",e=>{if(!drag)return;const p=point(e),moving=blocks.find(b=>b.id===drag.id);if(!moving)return;const result=snapBlock({...moving,x:Math.max(0,p.x-drag.dx),y:Math.max(0,p.y-drag.dy)},drag.id);blocks=blocks.map(b=>b.id===drag.id?result.block:b);if(result.snapped)status("支柱位置に吸着しました");renderBlocks();updateSummary()});
stage.addEventListener("pointerup",()=>{if(drag){drag=null;saveLocal()}});stage.addEventListener("pointercancel",()=>drag=null);
$("zoomOut").onclick=async()=>{zoom=Math.max(.5,+(zoom-.15).toFixed(2));$("zoomLabel").textContent=Math.round(zoom*100)+"%";pdfDoc?await renderPdf():setStageSize()};
$("zoomIn").onclick=async()=>{zoom=Math.min(2.5,+(zoom+.15).toFixed(2));$("zoomLabel").textContent=Math.round(zoom*100)+"%";pdfDoc?await renderPdf():setStageSize()};
$("undo").onclick=()=>{const prev=history.at(-1);if(!prev)return;future=[structuredClone(blocks),...future];blocks=prev;history=history.slice(0,-1);selectBlock(null);saveLocal();renderBlocks();updateSummary()};
$("redo").onclick=()=>{const next=future[0];if(!next)return;history=[...history,structuredClone(blocks)];blocks=next;future=future.slice(1);selectBlock(null);saveLocal();renderBlocks();updateSummary()};
$("selectedHeight").onchange=e=>{const b=blocks.find(v=>v.id===selectedId);if(!b)return;commit(blocks.map(v=>v.id===selectedId?{...v,height:Number(e.target.value)}:v));selectBlock(selectedId)};
$("rotate").onclick=()=>{const b=blocks.find(v=>v.id===selectedId);if(b){commit(blocks.map(v=>v.id===selectedId?{...v,rotation:v.rotation===0?90:0}:v));selectBlock(selectedId)}};
$("duplicate").onclick=()=>{const b=blocks.find(v=>v.id===selectedId);if(b){const copy={...b,id:uid(),x:b.x+18,y:b.y+18};commit([...blocks,copy]);selectBlock(copy.id)}};
$("remove").onclick=()=>{if(selectedId){commit(blocks.filter(v=>v.id!==selectedId));selectBlock(null)}};
$("saveProject").onclick=()=>{download("足場拾いデータ.json",JSON.stringify({version:1,blocks,mmPerPx,drawingScale,savedAt:new Date().toISOString()},null,2),"application/json");status("作業データを保存しました")};
$("projectInput").onchange=async e=>{try{const data=JSON.parse(await e.target.files[0].text());if(!Array.isArray(data.blocks))throw new Error();history=[...history,structuredClone(blocks)];blocks=data.blocks;mmPerPx=data.mmPerPx||mmPerPx;drawingScale=data.drawingScale||drawingScale;$("drawingScale").value=drawingScale;selectBlock(null);saveLocal();renderBlocks();updateSummary();status("作業データを読み込みました")}catch{status("作業データを読み込めませんでした")}};
$("csv").onclick=()=>{const rows=[["部材名","規格・条件","数量","単位"],...quantities()],csv="\ufeff"+rows.map(r=>r.map(v=>'"'+String(v).replaceAll('"','""')+'"').join(",")).join("\r\n");download("足場概算数量.csv",csv,"text/csv;charset=utf-8")};
$("print").onclick=()=>window.print();

try{const data=JSON.parse(localStorage.getItem(KEY)||"{}");if(Array.isArray(data.blocks))blocks=data.blocks;if(data.mmPerPx)mmPerPx=data.mmPerPx;if(data.drawingScale){drawingScale=data.drawingScale;$("drawingScale").value=drawingScale}if(blocks.length)status("前回の配置データを復元しました")}catch{localStorage.removeItem(KEY)}
setStageSize();renderBlocks();updateSummary();status($("status").textContent);
