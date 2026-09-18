import * as pdfjsLib from "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.10.38/pdf.min.mjs";
pdfjsLib.GlobalWorkerOptions.workerSrc = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.10.38/pdf.worker.min.mjs";

const $ = id => document.getElementById(id);
const COLORS = {1829:"#1684f8",1524:"#00a88f",1219:"#6f63e8",914:"#e88b18",610:"#dd4e68"};
const POST_SIZES=[3800,2850,1900,1425,950,475],LOWER_POST_SIZES=[2750,1425,950,475,238];
const BASE_SCALE = 1.25, KEY = "ashiba-hayami-v1";
const columnPlanCache=new Map();
let blocks=[],history=[],future=[],selectedId=null,selectedIds=new Set(),tool="add";
let span=1829,width=610,defaultFL=7600,defaultBaseHeight=0,drawingScale=100,mmPerPx=28.222,zoom=1;
let pdfDoc=null,pageNumber=1,pageCount=0,baseStage={width:1120,height:760};
let calibrationPoints=[],drag=null,range=null,pan=null,renderTask=null,fitOnNextRender=false,panelCollapsed=true,suppressNextClick=false;
let wheelTimer=null,pendingWheelZoom=null,wheelAnchor=null;

const stage=$("stage"),layer=$("blocksLayer"),postsLayer=$("postsLayer"),selectionLayer=$("selectionLayer"),calLayer=$("calibrationLayer"),canvas=$("pdfCanvas"),canvasScroll=$("canvasScroll");
const uid=()=>Date.now().toString(36)+"-"+Math.random().toString(36).slice(2,8);
const status=message=>{$("status").textContent=message;$("ratio").textContent=mmPerPx.toFixed(2)+" mm / px"};
const scaffoldHeight=b=>Math.max(0,Number(b.fl??b.height??0)-Number(b.baseHeight??0));
const normalizeBlock=b=>{
  const baseHeight=Number(b.baseHeight??0),fl=Number(b.fl??(Number(b.height??7600)+baseHeight));
  return{...b,fl,baseHeight,height:Math.max(0,fl-baseHeight)};
};
const saveLocal=()=>localStorage.setItem(KEY,JSON.stringify({blocks,mmPerPx,drawingScale,defaultFL,defaultBaseHeight,panelCollapsed}));
const setSectionOpen=(id,open)=>{
  const section=$(id);if(!section)return;
  section.classList.toggle("open",open);const toggle=section.querySelector(".section-toggle"),mark=section.querySelector(".section-chevron");
  toggle?.setAttribute("aria-expanded",String(open));if(mark)mark.textContent=open?"−":"＋";
};
const setTool=next=>{
  tool=next;stage.classList.remove("tool-add","tool-select","tool-calibrate");stage.classList.add("tool-"+next);
  $("selectMode").classList.toggle("active",next==="select");$("placeMode").classList.toggle("active",next==="add");
  $("calibrate").classList.toggle("primary",next==="calibrate");
};
const commit=next=>{
  history=[...history.slice(-39),structuredClone(blocks)];future=[];blocks=next.map(normalizeBlock);
  saveLocal();renderBlocks();updateSummary();
};
const point=event=>{const r=stage.getBoundingClientRect();return{x:(event.clientX-r.left)/zoom,y:(event.clientY-r.top)/zoom}};
const dimensions=b=>({w:(b.rotation===0?b.span:b.width)/mmPerPx,h:(b.rotation===0?b.width:b.span)/mmPerPx});
const corners=b=>{const{w,h}=dimensions(b);return[[b.x,b.y],[b.x+w,b.y],[b.x,b.y+h],[b.x+w,b.y+h]]};
const rectangle=(a,b)=>({left:Math.min(a.x,b.x),top:Math.min(a.y,b.y),right:Math.max(a.x,b.x),bottom:Math.max(a.y,b.y)});
const selectedBlocks=()=>blocks.filter(b=>selectedIds.has(b.id));

function uniquePostPositions(){
  const positions=new Map();
  blocks.forEach(b=>corners(b).forEach(([x,y])=>{
    const key=Math.round(x*1000)+","+Math.round(y*1000),current=positions.get(key);
    if(current){
      if(selectedIds.has(b.id))current.selected=true;
      current.baseHeight=Math.min(current.baseHeight,Number(b.baseHeight||0));
      current.fl=Math.max(current.fl,Number(b.fl||0));
    }else positions.set(key,{x,y,selected:selectedIds.has(b.id),baseHeight:Number(b.baseHeight||0),fl:Number(b.fl||0)});
  }));
  return[...positions.values()].map(p=>({...p,height:Math.max(0,p.fl-p.baseHeight)}));
}

function solveColumn(rawHeight){
  const height=Math.round(Math.max(0,Number(rawHeight)||0));
  if(columnPlanCache.has(height))return columnPlanCache.get(height);
  const maxRegular=Math.max(0,height-Math.min(...LOWER_POST_SIZES)-45),plans=new Map([[0,[]]]);
  for(let sum=0;sum<=maxRegular;sum++){
    const plan=plans.get(sum);if(!plan)continue;
    POST_SIZES.forEach(size=>{
      const next=sum+size;if(next>maxRegular)return;
      const candidate=[...plan,size],existing=plans.get(next);
      const candidate1900=candidate.filter(v=>v===1900).length,existing1900=existing?.filter(v=>v===1900).length??-1;
      if(!existing||candidate.length<existing.length||(candidate.length===existing.length&&candidate1900>existing1900))plans.set(next,candidate);
    });
  }
  const candidates=[];
  LOWER_POST_SIZES.forEach(lower=>plans.forEach((regular,regularTotal)=>{
    const jack=height-lower-regularTotal;
    if(jack>=45&&jack<=345)candidates.push({lower,regular,jack,pieces:regular.length+1,standard:regular.filter(v=>v===1900).length});
  }));
  candidates.sort((a,b)=>a.pieces-b.pieces||Math.abs(a.jack-150)-Math.abs(b.jack-150)||b.standard-a.standard||b.lower-a.lower);
  const result=candidates[0]||null;columnPlanCache.set(height,result);return result;
}

function verticalBreakdown(posts){
  const lower=new Map(),regular=new Map(),jacks=new Map();let unresolved=0;
  posts.forEach(post=>{
    const plan=solveColumn(post.height);if(!plan){unresolved++;return}
    lower.set(plan.lower,(lower.get(plan.lower)||0)+1);
    plan.regular.forEach(size=>regular.set(size,(regular.get(size)||0)+1));
    jacks.set(plan.jack,(jacks.get(plan.jack)||0)+1);
  });
  const rows=[];
  [...lower].sort((a,b)=>b[0]-a[0]).forEach(([size,count])=>rows.push(["下部支柱 "+size,"最下段・IQ系",count,"本"]));
  [...regular].sort((a,b)=>b[0]-a[0]).forEach(([size,count])=>rows.push(["支柱 "+size,"通常支柱・IQ系",count,"本"]));
  [...jacks].sort((a,b)=>a[0]-b[0]).forEach(([length,count])=>rows.push(["ジャッキベース","AJP・使用長 "+length+"mm",count,"本"]));
  if(unresolved)rows.push(["支柱構成 要確認","規格内で構成できない高さ",unresolved,"箇所"]);
  return rows;
}
const overlapArea=(a,b)=>{
  const ad=dimensions(a),bd=dimensions(b);
  return Math.max(0,Math.min(a.x+ad.w,b.x+bd.w)-Math.max(a.x,b.x))*Math.max(0,Math.min(a.y+ad.h,b.y+bd.h)-Math.max(a.y,b.y));
};
function snapBlock(candidate,excludeId=null){
  const threshold=18/zoom,candidateCorners=corners(candidate);let best=null;
  blocks.filter(b=>b.id!==excludeId).forEach(other=>corners(other).forEach(target=>candidateCorners.forEach(source=>{
    const dx=target[0]-source[0],dy=target[1]-source[1],distance=Math.hypot(dx,dy);
    if(distance>threshold||(best&&distance>=best.distance))return;
    const snapped={...candidate,x:Math.max(0,candidate.x+dx),y:Math.max(0,candidate.y+dy)};
    if(overlapArea(snapped,other)>1)return;best={block:snapped,distance};
  })));
  return best?{block:best.block,snapped:true}:{block:candidate,snapped:false};
}

async function loadPdf(file){
  try{
    status("PDFを読み込んでいます…");
    pdfDoc=await pdfjsLib.getDocument({data:new Uint8Array(await file.arrayBuffer())}).promise;
    pageCount=pdfDoc.numPages;pageNumber=1;$("pdfName").textContent=file.name;$("pdfHelp").textContent=pageCount+"ページ";
    $("pageNav").classList.toggle("hidden",pageCount<2);mmPerPx=drawingScale*(25.4/72)/BASE_SCALE;fitOnNextRender=true;
    await renderPdf();setSectionOpen("drawingSection",false);setSectionOpen("scaleSection",true);status(file.name+" を読み込みました（全体表示）");
  }catch(error){console.error(error);status("PDFを読み込めませんでした。別のPDFでお試しください")}
}
async function renderPdf(){
  if(!pdfDoc)return;try{renderTask?.cancel?.()}catch{}
  const page=await pdfDoc.getPage(pageNumber),base=page.getViewport({scale:BASE_SCALE});
  baseStage={width:base.width,height:base.height};
  if(fitOnNextRender){
    const scroll=$("canvasScroll");
    zoom=Math.max(.35,Math.min(2.5,(scroll.clientWidth-32)/baseStage.width,(scroll.clientHeight-32)/baseStage.height));
    fitOnNextRender=false;$("zoomLabel").textContent=Math.round(zoom*100)+"%";
  }
  const view=page.getViewport({scale:BASE_SCALE*zoom});setStageSize();
  const ratio=window.devicePixelRatio||1,ctx=canvas.getContext("2d");
  canvas.width=Math.floor(view.width*ratio);canvas.height=Math.floor(view.height*ratio);
  canvas.style.width=view.width+"px";canvas.style.height=view.height+"px";ctx.setTransform(ratio,0,0,ratio,0,0);
  renderTask=page.render({canvasContext:ctx,viewport:view});
  try{await renderTask.promise}catch(error){if(error?.name==="RenderingCancelledException")return;throw error}
  canvas.classList.add("visible");$("emptyPlan").classList.add("hidden");$("pageLabel").textContent=pageNumber+" / "+pageCount;
}
async function fitToView(){
  const scroll=$("canvasScroll");
  zoom=Math.max(.35,Math.min(2.5,(scroll.clientWidth-32)/baseStage.width,(scroll.clientHeight-32)/baseStage.height));
  $("zoomLabel").textContent=Math.round(zoom*100)+"%";pdfDoc?await renderPdf():setStageSize();
}
function setStageSize(){
  stage.style.width=baseStage.width*zoom+"px";stage.style.height=baseStage.height*zoom+"px";renderBlocks();renderCalibration();
}
async function applyZoom(nextZoom,anchor=null){
  const next=Math.max(.35,Math.min(2.5,+nextZoom.toFixed(2)));if(next===zoom)return;
  const rect=canvasScroll.getBoundingClientRect(),localX=anchor?anchor.clientX-rect.left:canvasScroll.clientWidth/2,localY=anchor?anchor.clientY-rect.top:canvasScroll.clientHeight/2;
  const contentX=canvasScroll.scrollLeft+localX,contentY=canvasScroll.scrollTop+localY,previous=zoom;zoom=next;
  $("zoomLabel").textContent=Math.round(zoom*100)+"%";pdfDoc?await renderPdf():setStageSize();
  const factor=zoom/previous;canvasScroll.scrollLeft=Math.max(0,contentX*factor-localX);canvasScroll.scrollTop=Math.max(0,contentY*factor-localY);
}
function renderBlocks(){
  layer.innerHTML="";
  blocks.forEach(b=>{
    const{w,h}=dimensions(b),selected=selectedIds.has(b.id),el=document.createElement("button");
    el.className="scaffold-block"+(selected?" selected":"")+(selected&&selectedIds.size>1?" multi-selected":"");el.dataset.id=b.id;
    Object.assign(el.style,{left:b.x*zoom+"px",top:b.y*zoom+"px",width:w*zoom+"px",height:h*zoom+"px",borderColor:COLORS[b.span],backgroundColor:COLORS[b.span]+"30","--c":COLORS[b.span]});
    el.innerHTML='<span class="block-size">'+b.span+" × "+b.width+"</span>";
    el.addEventListener("pointerdown",e=>{
      if(e.button!==0)return;e.stopPropagation();if(!selectedIds.has(b.id))selectBlocks([b.id]);setTool("select");
      const p=point(e);history=[...history.slice(-39),structuredClone(blocks)];future=[];
      const ids=[...selectedIds];drag={ids,start:p,origins:new Map(ids.map(id=>{const item=blocks.find(v=>v.id===id);return[id,{x:item.x,y:item.y}]}))};
      el.setPointerCapture(e.pointerId);
    });
    el.addEventListener("click",e=>e.stopPropagation());layer.appendChild(el);
  });
  renderPosts();$("undo").disabled=!history.length;$("redo").disabled=!future.length;
}
function renderPosts(){
  postsLayer.innerHTML="";
  uniquePostPositions().forEach(p=>{const el=document.createElement("i");el.className="post-dot"+(p.selected?" selected-post":"");el.style.left=p.x*zoom+"px";el.style.top=p.y*zoom+"px";postsLayer.appendChild(el)});
}
function renderCalibration(){
  calLayer.innerHTML="";
  calibrationPoints.forEach((p,i)=>{const el=document.createElement("span");el.className="cal-point";el.style.left=p.x*zoom+"px";el.style.top=p.y*zoom+"px";el.textContent=i+1;calLayer.appendChild(el)});
}
function renderRange(){
  selectionLayer.innerHTML="";if(!range)return;
  const r=rectangle(range.start,range.current),el=document.createElement("div");el.className="marquee";
  Object.assign(el.style,{left:r.left*zoom+"px",top:r.top*zoom+"px",width:(r.right-r.left)*zoom+"px",height:(r.bottom-r.top)*zoom+"px"});selectionLayer.appendChild(el);
}
function selectBlocks(ids){
  selectedIds=new Set(ids.filter(id=>blocks.some(b=>b.id===id)));selectedId=[...selectedIds].at(-1)??null;renderBlocks();updateSelectionEditor();
}
function selectBlock(id){selectBlocks(id?[id]:[])}
function updateSelectionEditor(){
  const selected=selectedBlocks(),has=selected.length>0;$("selectionEmpty").classList.toggle("hidden",has);$("selectionEditor").classList.toggle("hidden",!has);
  $("selectionBadge").textContent=has?(selected.length===1?"1件選択":selected.length+"件選択"):"未選択";if(!has)return;
  const first=selected[0],same=key=>selected.every(b=>Number(b[key])===Number(first[key]));
  $("selectedColor").style.background=selected.length===1?COLORS[first.span]:"#e53253";
  $("selectedSpec").textContent=selected.length===1?first.span+" × "+first.width:selected.length+"件の足場";
  document.querySelector(".selected-spec small").textContent=selected.length===1?"mm":"";
  $("selectedFL").value=same("fl")?first.fl:"";$("selectedFL").placeholder=same("fl")?"":"複数";
  $("selectedBaseHeight").value=same("baseHeight")?first.baseHeight:"";$("selectedBaseHeight").placeholder=same("baseHeight")?"":"複数";
  const heights=selected.map(scaffoldHeight),sameHeight=heights.every(v=>v===heights[0]);
  $("selectedActualHeight").textContent=sameHeight?heights[0].toLocaleString()+" mm":"複数";
  const levels=heights.map(v=>Math.ceil(v/1900));$("selectedLevels").textContent=levels.every(v=>v===levels[0])?levels[0]+"段":"複数";
}
function applyElevationChange(key,value){
  if(!selectedIds.size||value==="")return;const number=Number(value);
  commit(blocks.map(b=>{if(!selectedIds.has(b.id))return b;const changed={...b,[key]:number};return{...changed,height:scaffoldHeight(changed)}}));updateSelectionEditor();
}
function updateSummary(){
  const length=blocks.reduce((s,b)=>s+b.span,0)/1000,area=blocks.reduce((s,b)=>s+b.span/1000*scaffoldHeight(b)/1000,0);
  $("metricCount").textContent=blocks.length;$("metricLength").textContent=length.toFixed(1);$("metricArea").textContent=area.toFixed(1);
  const rows=quantities();$("csv").disabled=!rows.length;
  $("quantityBody").innerHTML=rows.length?rows.map(r=>`<tr><td>${r[0]}<small>${r[1]}</small></td><td><strong>${r[2].toLocaleString()}</strong> ${r[3]}</td></tr>`).join(""):'<tr><td colspan="2" class="zero">足場を配置すると集計します</td></tr>';
}
function quantities(){
  if(!blocks.length)return[];
  const levels=b=>Math.max(0,Math.ceil(scaffoldHeight(b)/1900)),posts=uniquePostPositions(),postCount=posts.length;
  const length=blocks.reduce((s,b)=>s+b.span,0)/1000,maxHeight=Math.max(...blocks.map(scaffoldHeight))/1000;
  const spanTotals=new Map(),widthTotals=new Map(),deckTotals=new Map();
  blocks.forEach(b=>{
    const count=levels(b);spanTotals.set(b.span,(spanTotals.get(b.span)||0)+count);widthTotals.set(b.width,(widthTotals.get(b.width)||0)+count*2);
    const deckKey=b.span+"×500";deckTotals.set(deckKey,(deckTotals.get(deckKey)||0)+count*Math.max(1,Math.ceil(b.width/500)));
  });
  const rows=[["支柱位置","共有支柱を重複除外",postCount,"箇所"],...verticalBreakdown(posts)];
  [...spanTotals].sort((a,b)=>b[0]-a[0]).forEach(([size,count])=>{
    rows.push(["布材 "+size,"スパン別・各段1本",count,"本"]);
    rows.push(["IQ手すり "+size,"内側・各段1本",count,"本"]);
    rows.push(["IQ先行手すり "+size,"外側・各段1枚",count,"枚"]);
    rows.push(["幅木 "+size,"外側・スパン別",count,"枚"]);
  });
  [...widthTotals].sort((a,b)=>b[0]-a[0]).forEach(([size,count])=>rows.push(["腕木 "+size,"足場幅別・各段2本",count,"本"]));
  [...deckTotals].sort((a,b)=>b[0].localeCompare(a[0],"ja",{numeric:true})).forEach(([size,count])=>rows.push(["鋼製踏板 "+size,"500幅換算",count,"枚"]));
  rows.push(["壁つなぎ","8m×9m目安",Math.max(1,Math.ceil(length/8)*Math.ceil(maxHeight/9)),"本"]);return rows;
}
function updateDefaultHeightPreview(){
  defaultFL=Number($("defaultFL").value||0);defaultBaseHeight=Number($("defaultBaseHeight").value||0);
  const actual=defaultFL-defaultBaseHeight;$("defaultActualHeight").textContent=Math.max(0,actual).toLocaleString()+" mm";$("addMode").disabled=actual<=0;saveLocal();
}
function applyPanelState(){
  document.querySelector(".workspace").classList.toggle("right-collapsed",panelCollapsed);$("rightPanel").classList.toggle("collapsed",panelCollapsed);
  $("summaryToggle").textContent=panelCollapsed?"‹":"›";$("summaryToggle").setAttribute("aria-expanded",String(!panelCollapsed));
  $("summaryToggle").title=panelCollapsed?"選択・概算数量を開く":"選択・概算数量を閉じる";
}
function download(name,content,type){
  const url=URL.createObjectURL(new Blob([content],{type})),a=document.createElement("a");a.href=url;a.download=name;a.click();URL.revokeObjectURL(url);
}
function removeSelected(){
  if(!selectedIds.size)return;
  const count=selectedIds.size;
  commit(blocks.filter(b=>!selectedIds.has(b.id)));
  selectBlocks([]);
  status(count+"件の足場を削除しました（元に戻すことができます）");
}

$("pdfInput").addEventListener("change",e=>e.target.files[0]&&loadPdf(e.target.files[0]));
document.querySelector(".pdf-drop").addEventListener("dragover",e=>e.preventDefault());
document.querySelector(".pdf-drop").addEventListener("drop",e=>{e.preventDefault();const f=e.dataTransfer.files[0];if(f?.type==="application/pdf")loadPdf(f)});
$("prevPage").onclick=async()=>{if(pageNumber>1){pageNumber--;fitOnNextRender=true;await renderPdf()}};
$("nextPage").onclick=async()=>{if(pageNumber<pageCount){pageNumber++;fitOnNextRender=true;await renderPdf()}};
$("drawingScale").onchange=e=>{drawingScale=Number(e.target.value);mmPerPx=drawingScale*(25.4/72)/BASE_SCALE;calibrationPoints=[];saveLocal();renderBlocks();renderCalibration();status("図面縮尺を 1/"+drawingScale+" に設定しました")};
$("calibrate").onclick=()=>{calibrationPoints=[];setTool("calibrate");renderCalibration();status("図面上の基準寸法の両端をクリックしてください")};
document.querySelectorAll("[data-span]").forEach(el=>el.onclick=()=>{document.querySelectorAll("[data-span]").forEach(v=>v.classList.remove("active"));el.classList.add("active");span=Number(el.dataset.span);setTool("add")});
$("scaffoldWidth").onchange=e=>width=Number(e.target.value);
$("defaultFL").oninput=updateDefaultHeightPreview;$("defaultBaseHeight").oninput=updateDefaultHeightPreview;
$("addMode").onclick=$("placeMode").onclick=()=>setTool("add");$("selectMode").onclick=()=>setTool("select");$("fitView").onclick=fitToView;
$("summaryToggle").onclick=()=>{panelCollapsed=!panelCollapsed;applyPanelState();saveLocal()};
document.querySelectorAll(".section-toggle").forEach(toggle=>toggle.addEventListener("click",()=>setSectionOpen(toggle.closest(".setup-section").id,toggle.getAttribute("aria-expanded")!=="true")));

canvasScroll.addEventListener("wheel",event=>{
  event.preventDefault();wheelAnchor={clientX:event.clientX,clientY:event.clientY};
  pendingWheelZoom=Math.max(.35,Math.min(2.5,(pendingWheelZoom??zoom)+(event.deltaY<0?.12:-.12)));
  clearTimeout(wheelTimer);wheelTimer=setTimeout(()=>{const next=pendingWheelZoom,anchor=wheelAnchor;pendingWheelZoom=null;wheelAnchor=null;applyZoom(next,anchor)},45);
},{passive:false});
canvasScroll.addEventListener("pointerdown",event=>{
  if(event.button!==1)return;event.preventDefault();pan={pointerId:event.pointerId,startX:event.clientX,startY:event.clientY,left:canvasScroll.scrollLeft,top:canvasScroll.scrollTop};
  canvasScroll.classList.add("is-panning");canvasScroll.setPointerCapture(event.pointerId);
});
canvasScroll.addEventListener("pointermove",event=>{
  if(!pan||event.pointerId!==pan.pointerId)return;event.preventDefault();canvasScroll.scrollLeft=pan.left-(event.clientX-pan.startX);canvasScroll.scrollTop=pan.top-(event.clientY-pan.startY);
});
const stopPan=event=>{if(!pan||event.pointerId!==pan.pointerId)return;pan=null;canvasScroll.classList.remove("is-panning")};
canvasScroll.addEventListener("pointerup",stopPan);canvasScroll.addEventListener("pointercancel",stopPan);canvasScroll.addEventListener("auxclick",event=>{if(event.button===1)event.preventDefault()});

stage.addEventListener("contextmenu",e=>e.preventDefault());
stage.addEventListener("pointerdown",e=>{
  if(e.button!==2&&!(e.button===0&&e.shiftKey))return;e.preventDefault();setTool("select");const p=point(e);range={start:p,current:p};
  stage.classList.add("range-selecting");stage.setPointerCapture(e.pointerId);renderRange();
});
stage.addEventListener("click",e=>{
  if(suppressNextClick){suppressNextClick=false;return}
  const p=point(e);
  if(tool==="calibrate"){
    calibrationPoints=[...calibrationPoints,p].slice(-2);renderCalibration();
    if(calibrationPoints.length===2){
      const px=Math.hypot(calibrationPoints[1].x-calibrationPoints[0].x,calibrationPoints[1].y-calibrationPoints[0].y),known=Number($("knownLength").value);
      if(px>2&&known>0){mmPerPx=known/px;saveLocal();renderBlocks();status("基準寸法 "+known.toLocaleString()+"mm で補正しました");setTool("add")}
    }return;
  }
  if(tool!=="add"){selectBlock(null);return}
  const actualHeight=defaultFL-defaultBaseHeight;if(actualHeight<=0){status("上端FLは設置面高さより大きくしてください");return}
  const w=span/mmPerPx,d=width/mmPerPx,raw={id:uid(),x:Math.max(0,p.x-w/2),y:Math.max(0,p.y-d/2),span,width,fl:defaultFL,baseHeight:defaultBaseHeight,height:actualHeight,rotation:0};
  const result=snapBlock(raw),b=result.block;commit([...blocks,b]);selectBlock(b.id);status(result.snapped?"支柱位置に吸着して配置しました":span+"mmスパンを配置しました");
});
stage.addEventListener("pointermove",e=>{
  const p=point(e);if(range){range.current=p;renderRange();return}if(!drag)return;
  const dx=p.x-drag.start.x,dy=p.y-drag.start.y;
  if(drag.ids.length===1){
    const id=drag.ids[0],moving=blocks.find(b=>b.id===id),origin=drag.origins.get(id);if(!moving||!origin)return;
    const result=snapBlock({...moving,x:Math.max(0,origin.x+dx),y:Math.max(0,origin.y+dy)},id);
    blocks=blocks.map(b=>b.id===id?result.block:b);if(result.snapped)status("支柱位置に吸着しました");
  }else{
    blocks=blocks.map(b=>{const origin=drag.origins.get(b.id);return origin?{...b,x:Math.max(0,origin.x+dx),y:Math.max(0,origin.y+dy)}:b});
  }
  renderBlocks();updateSummary();
});
stage.addEventListener("pointerup",e=>{
  if(range){
    range.current=point(e);const r=rectangle(range.start,range.current);
    const ids=blocks.filter(b=>{const d=dimensions(b);return b.x+d.w>=r.left&&b.x<=r.right&&b.y+d.h>=r.top&&b.y<=r.bottom}).map(b=>b.id);
    range=null;suppressNextClick=true;stage.classList.remove("range-selecting");renderRange();selectBlocks(ids);status(ids.length?ids.length+"件の足場を範囲選択しました":"範囲内に足場がありません");
  }
  if(drag){drag=null;saveLocal();updateSelectionEditor()}
});
stage.addEventListener("pointercancel",()=>{drag=null;range=null;stage.classList.remove("range-selecting");renderRange()});

$("zoomOut").onclick=()=>applyZoom(zoom-.15);$("zoomIn").onclick=()=>applyZoom(zoom+.15);
$("undo").onclick=()=>{const prev=history.at(-1);if(!prev)return;future=[structuredClone(blocks),...future];blocks=prev.map(normalizeBlock);history=history.slice(0,-1);selectBlocks([]);saveLocal();renderBlocks();updateSummary()};
$("redo").onclick=()=>{const next=future[0];if(!next)return;history=[...history,structuredClone(blocks)];blocks=next.map(normalizeBlock);future=future.slice(1);selectBlocks([]);saveLocal();renderBlocks();updateSummary()};
$("selectedFL").onchange=e=>applyElevationChange("fl",e.target.value);
$("selectedBaseHeight").onchange=e=>applyElevationChange("baseHeight",e.target.value);
$("rotate").onclick=()=>{if(!selectedIds.size)return;commit(blocks.map(b=>selectedIds.has(b.id)?{...b,rotation:b.rotation===0?90:0}:b));updateSelectionEditor()};
$("duplicate").onclick=()=>{const copies=selectedBlocks().map(b=>({...b,id:uid(),x:b.x+18,y:b.y+18}));if(!copies.length)return;commit([...blocks,...copies]);selectBlocks(copies.map(b=>b.id))};
$("remove").onclick=removeSelected;
document.addEventListener("keydown",e=>{
  if(e.key!=="Delete"&&e.key!=="Backspace")return;
  const target=e.target;
  if(target instanceof HTMLInputElement||target instanceof HTMLTextAreaElement||target instanceof HTMLSelectElement||target?.isContentEditable)return;
  if(!selectedIds.size)return;
  e.preventDefault();
  removeSelected();
});
$("saveProject").onclick=()=>{download("足場拾いデータ.json",JSON.stringify({version:2,blocks,mmPerPx,drawingScale,savedAt:new Date().toISOString()},null,2),"application/json");status("作業データを保存しました")};
$("projectInput").onchange=async e=>{try{const data=JSON.parse(await e.target.files[0].text());if(!Array.isArray(data.blocks))throw new Error();history=[...history,structuredClone(blocks)];blocks=data.blocks.map(normalizeBlock);mmPerPx=data.mmPerPx||mmPerPx;drawingScale=data.drawingScale||drawingScale;$("drawingScale").value=drawingScale;selectBlocks([]);saveLocal();renderBlocks();updateSummary();status("作業データを読み込みました")}catch{status("作業データを読み込めませんでした")}};
$("csv").onclick=()=>{const rows=[["部材名","規格・条件","数量","単位"],...quantities()],csv="\ufeff"+rows.map(r=>r.map(v=>'"'+String(v).replaceAll('"','""')+'"').join(",")).join("\r\n");download("足場概算数量.csv",csv,"text/csv;charset=utf-8")};
$("print").onclick=()=>window.print();

try{
  const data=JSON.parse(localStorage.getItem(KEY)||"{}");
  if(Array.isArray(data.blocks))blocks=data.blocks.map(normalizeBlock);if(data.mmPerPx)mmPerPx=data.mmPerPx;
  if(data.drawingScale){drawingScale=data.drawingScale;$("drawingScale").value=drawingScale}
  if(Number.isFinite(data.defaultFL)){defaultFL=data.defaultFL;$("defaultFL").value=defaultFL}
  if(Number.isFinite(data.defaultBaseHeight)){defaultBaseHeight=data.defaultBaseHeight;$("defaultBaseHeight").value=defaultBaseHeight}
  if(typeof data.panelCollapsed==="boolean")panelCollapsed=data.panelCollapsed;if(blocks.length)status("前回の配置データを復元しました");
}catch{localStorage.removeItem(KEY)}
updateDefaultHeightPreview();applyPanelState();setStageSize();renderBlocks();updateSummary();updateSelectionEditor();status($("status").textContent);
