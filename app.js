import * as pdfjsLib from "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.10.38/pdf.min.mjs";
pdfjsLib.GlobalWorkerOptions.workerSrc = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.10.38/pdf.worker.min.mjs";

const $ = id => document.getElementById(id);
const COLORS = {1829:"#1684f8",1524:"#00a88f",1219:"#6f63e8",914:"#e88b18",610:"#dd4e68"};
const POST_SIZES=[3800,2850,1900,1425,950,475],LOWER_POST_SIZES=[2750,1425,950,475,238];
const BASE_SCALE = 1.25, KEY = "ashiba-hayami-v1";
const columnPlanCache=new Map();
let blocks=[],history=[],future=[],selectedId=null,selectedIds=new Set(),tool="add",placementStair=false;
let span=1829,width=610,defaultFL=700,defaultBaseHeight=0,defaultFloorCount=1,drawingScale=100,mmPerPx=28.222,zoom=1;
let pdfDoc=null,pageNumber=1,pageCount=0,baseStage={width:1120,height:760};
let calibrationPoints=[],drag=null,range=null,pan=null,renderTask=null,fitOnNextRender=false,panelCollapsed=true,suppressNextClick=false;
let wheelTimer=null,pendingWheelZoom=null,wheelAnchor=null,levelApplyTimer=null;

const stage=$("stage"),layer=$("blocksLayer"),postsLayer=$("postsLayer"),selectionLayer=$("selectionLayer"),calLayer=$("calibrationLayer"),canvas=$("pdfCanvas"),canvasScroll=$("canvasScroll");
const uid=()=>Date.now().toString(36)+"-"+Math.random().toString(36).slice(2,8);
const status=message=>{$("status").textContent=message;$("ratio").textContent=mmPerPx.toFixed(2)+" mm / px"};
const firstFloorHeight=b=>Math.max(0,Number(b.firstFloorFL??b.fl??0)-Number(b.baseHeight??0));
const floorCountOf=b=>Math.max(1,Math.round(Number(b.floorCount)||1));
const workFloorHeights=b=>Array.from({length:floorCountOf(b)},(_,i)=>firstFloorHeight(b)+i*1900);
const scaffoldHeight=b=>workFloorHeights(b).at(-1)??0;
const liftCount=b=>Math.max(0,floorCountOf(b)-1);
const normalizeBlock=b=>{
  const baseHeight=Number(b.baseHeight??0),firstFloorFL=Number(b.firstFloorFL??b.fl??(700+baseHeight)),floorCount=floorCountOf(b),fl=firstFloorFL+(floorCount-1)*1900;
  return{...b,firstFloorFL,floorCount,fl,baseHeight,height:Math.max(0,fl-baseHeight),outerProtection:b.outerProtection??"handrail",innerProtection:b.innerProtection??"handrail",hasStair:Boolean(b.hasStair)&&Number(b.span)===1829&&floorCount>1};
};
const saveLocal=()=>localStorage.setItem(KEY,JSON.stringify({blocks,mmPerPx,drawingScale,defaultFL,defaultBaseHeight,defaultFloorCount,panelCollapsed,levelSettingsApplyAll:true,workFloorBasisV2:true}));
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
      if(scaffoldHeight(b)>current.height){current.fl=Number(b.fl||0);current.height=scaffoldHeight(b);current.firstHeight=firstFloorHeight(b);current.floorCount=floorCountOf(b)}
    }else positions.set(key,{x,y,selected:selectedIds.has(b.id),baseHeight:Number(b.baseHeight||0),fl:Number(b.fl||0),height:scaffoldHeight(b),firstHeight:firstFloorHeight(b),floorCount:floorCountOf(b)});
  }));
  return[...positions.values()];
}

function uniquePlanEdges(){
  const edges=new Map();
  blocks.forEach(b=>{
    const c=corners(b),widthRail=b.width===610?600:b.width===914?900:b.width;
    const horizontalSize=b.rotation===0?b.span:widthRail,verticalSize=b.rotation===0?widthRail:b.span;
    [[c[0],c[1],horizontalSize],[c[2],c[3],horizontalSize],[c[0],c[2],verticalSize],[c[1],c[3],verticalSize]].forEach(([start,end,size])=>{
      const a=[Math.round(start[0]*1000),Math.round(start[1]*1000)],z=[Math.round(end[0]*1000),Math.round(end[1]*1000)];
      const ordered=a[0]<z[0]||(a[0]===z[0]&&a[1]<=z[1])?[a,z]:[z,a],key=ordered[0].join(",")+"|"+ordered[1].join(",");
      if(!edges.has(key))edges.set(key,{size});
    });
  });
  return[...edges.values()];
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
  candidates.sort((a,b)=>a.pieces-b.pieces||b.lower-a.lower||b.standard-a.standard||Math.abs(a.jack-150)-Math.abs(b.jack-150));
  const result=candidates[0]||null;columnPlanCache.set(height,result);return result;
}

function verticalBreakdown(posts){
  const lower=new Map(),regular=new Map(),jacks=new Map();let unresolved=0;
  posts.forEach(post=>{
    const plan=solveColumn(post.firstHeight);if(!plan){unresolved++;return}
    lower.set(plan.lower,(lower.get(plan.lower)||0)+1);
    plan.regular.forEach(size=>regular.set(size,(regular.get(size)||0)+1));
    for(let i=1;i<post.floorCount;i++)regular.set(1900,(regular.get(1900)||0)+1);
    regular.set(950,(regular.get(950)||0)+1);
    jacks.set(plan.jack,(jacks.get(plan.jack)||0)+1);
  });
  const rows=[];
  [...lower].sort((a,b)=>b[0]-a[0]).forEach(([size,count])=>rows.push(["下部支柱 "+size,"IQ下部支柱",count,"本"]));
  [...regular].sort((a,b)=>b[0]-a[0]).forEach(([size,count])=>rows.push(["支柱 "+size,"IQ支柱",count,"本"]));
  [...jacks].sort((a,b)=>a[0]-b[0]).forEach(([useHeight,count])=>rows.push(["HPJ5-450","使用高さ "+useHeight+"mm",count,"本"]));
  if(unresolved)rows.push(["支柱構成 要確認","規格内で構成できない高さ",unresolved,"箇所"]);
  return rows;
}

function connectedBlockGroups(){
  const remaining=new Set(blocks.map(b=>b.id)),groups=[];
  while(remaining.size){
    const first=remaining.values().next().value,queue=[first],group=[];remaining.delete(first);
    while(queue.length){
      const id=queue.shift(),block=blocks.find(b=>b.id===id);if(!block)continue;group.push(block);
      blocks.forEach(other=>{if(!remaining.has(other.id))return;const touches=corners(block).some(a=>corners(other).some(b=>Math.hypot(a[0]-b[0],a[1]-b[1])<.01));if(touches){remaining.delete(other.id);queue.push(other.id)}});
    }
    groups.push(group);
  }
  return groups;
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
    el.className="scaffold-block"+(selected?" selected":"")+(selected&&selectedIds.size>1?" multi-selected":"")+(b.hasStair?" has-stair":"");el.dataset.id=b.id;
    Object.assign(el.style,{left:b.x*zoom+"px",top:b.y*zoom+"px",width:w*zoom+"px",height:h*zoom+"px",borderColor:COLORS[b.span],backgroundColor:COLORS[b.span]+"30","--c":COLORS[b.span]});
    el.innerHTML='<span class="block-size">'+b.span+" × "+b.width+(b.hasStair?' <em>階段</em>':'')+"</span>";
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
function renderSelectionSection(selected){
  const items=[...(Array.isArray(selected)?selected:[selected])].sort((a,b)=>(a.rotation===0?a.x:a.y)-(b.rotation===0?b.x:b.y));
  const preview=$("selectionSectionView"),totalSpan=items.reduce((sum,b)=>sum+Number(b.span),0),maxUpper=Math.max(...items.map(b=>scaffoldHeight(b)+900),1);
  const bottom=132,top=14,left=36,right=224,usable=bottom-top,yAt=elevation=>bottom-(elevation/maxUpper)*usable;let cursor=left;
  const bays=items.map((block,index)=>{
    const x1=cursor,x2=index===items.length-1?right:cursor+(right-left)*block.span/totalSpan;cursor=x2;
    const blockFloors=workFloorHeights(block),floors=blockFloors.map((levelHeight,floorIndex)=>{const y=yAt(levelHeight),r450=yAt(levelHeight+450),r900=yAt(levelHeight+900),lower=floorIndex>0?blockFloors[floorIndex-1]:null;return`<line class="section-floor" x1="${x1}" y1="${y}" x2="${x2}" y2="${y}"/><line class="section-handrail" x1="${x1}" y1="${r450}" x2="${x2}" y2="${r450}"/><line class="section-handrail" x1="${x1}" y1="${r900}" x2="${x2}" y2="${r900}"/>${block.hasStair&&lower!==null?`<line class="section-stair" x1="${x1+3}" y1="${yAt(lower)}" x2="${x2-3}" y2="${y}"/>`:""}`}).join("");
    return`<line class="section-post" x1="${x1}" y1="${yAt(scaffoldHeight(block)+900)}" x2="${x1}" y2="${bottom}"/>${index===items.length-1?`<line class="section-post" x1="${x2}" y1="${yAt(scaffoldHeight(block)+900)}" x2="${x2}" y2="${bottom}"/>`:""}${floors}<text class="section-bay-label" x="${(x1+x2)/2}" y="144" text-anchor="middle">${block.span}</text>`;
  }).join("");
  preview.innerHTML=`<svg viewBox="0 0 260 166" role="img" aria-label="長手方向 ${items.length}区画、合計${totalSpan}ミリ"><line class="section-ground" x1="24" y1="${bottom+3}" x2="236" y2="${bottom+3}"/>${bays}<text class="section-height" x="250" y="76" text-anchor="middle" transform="rotate(-90 250 76)">上部 FL ${(Math.max(...items.map(b=>Number(b.fl)))+900).toLocaleString()} mm</text><text class="section-width" x="130" y="160" text-anchor="middle">合計 ${totalSpan.toLocaleString()} mm</text><text class="section-badge" x="36" y="11">${items.length}区画・作業床最大${Math.max(...items.map(floorCountOf))}層</text></svg>`;
}
function updateSelectionEditor(){
  const selected=selectedBlocks(),has=selected.length>0;$("selectionEmpty").classList.toggle("hidden",has);$("selectionEditor").classList.toggle("hidden",!has);
  $("selectionBadge").textContent=has?(selected.length===1?"1件選択":selected.length+"件選択"):"未選択";if(!has)return;
  const first=selected[0],same=key=>selected.every(b=>Number(b[key])===Number(first[key]));
  $("selectionSectionView").classList.remove("hidden");renderSelectionSection(selected);
  $("selectedColor").style.background=selected.length===1?COLORS[first.span]:"#e53253";
  $("selectedSpec").textContent=selected.length===1?first.span+" × "+first.width:selected.length+"件・合計"+selected.reduce((sum,b)=>sum+b.span,0).toLocaleString()+"mm";
  document.querySelector(".selected-spec small").textContent=selected.length===1?"mm":"";
  $("selectedFL").value=same("firstFloorFL")?first.firstFloorFL:"";$("selectedFL").placeholder=same("firstFloorFL")?"":"複数";
  $("selectedBaseHeight").value=same("baseHeight")?first.baseHeight:"";$("selectedBaseHeight").placeholder=same("baseHeight")?"":"複数";
  $("selectedFloorCount").value=same("floorCount")?first.floorCount:"";$("selectedFloorCount").placeholder=same("floorCount")?"":"複数";
  const upperLevels=selected.map(b=>Number(b.fl)+900),sameUpper=upperLevels.every(v=>v===upperLevels[0]);
  $("selectedActualHeight").textContent=sameUpper?"FL "+upperLevels[0].toLocaleString()+" mm":"複数";
  const tops=selected.map(scaffoldHeight),floorCounts=selected.map(floorCountOf);
  $("selectedLevels").textContent=tops.every(v=>v===tops[0])&&floorCounts.every(v=>v===floorCounts[0])?floorCounts[0]+"層（最上段"+tops[0].toLocaleString()+"mm）":"複数";
  const stairEligible=selected.every(b=>b.span===1829&&floorCountOf(b)>1),allStairs=stairEligible&&selected.every(b=>b.hasStair);$("toggleStair").classList.remove("hidden");$("toggleStair").disabled=!stairEligible;$("toggleStair").textContent=!stairEligible?"階段は1829・2層以上":allStairs?"選択した足場の階段を解除":"選択した足場を階段付きに変更";
}
function applyElevationChange(key,value){
  if(!selectedIds.size||value==="")return;const number=Number(value);
  commit(blocks.map(b=>{if(!selectedIds.has(b.id))return b;const changed={...b,[key]:number};return{...changed,height:scaffoldHeight(changed)}}));updateSelectionEditor();
}
function updateSummary(){
  const length=blocks.reduce((s,b)=>s+b.span,0)/1000,area=blocks.reduce((s,b)=>s+b.span/1000*scaffoldHeight(b)/1000,0);
  $("metricCount").textContent=blocks.length;$("metricLength").textContent=length.toFixed(1);$("metricArea").textContent=area.toFixed(1);
  const rows=quantities();$("csv").disabled=!rows.length;
  $("quantityBody").innerHTML=rows.length?rows.map(r=>r[4]==="group"?`<tr class="quantity-group"><th colspan="2">${r[0]}${r[1]?`<small>${r[1]}</small>`:""}</th></tr>`:`<tr><td>${r[0]}<small>${r[1]}</small></td><td><strong>${r[2].toLocaleString()}</strong> ${r[3]}</td></tr>`).join(""):'<tr><td colspan="2" class="zero">足場を配置すると集計します</td></tr>';
}
function quantities(){
  if(!blocks.length)return[];
  const floorCount=floorCountOf,posts=uniquePostPositions(),postCount=posts.length;
  const rootTotals=new Map(),workHandrails=new Map(),deckTotals=new Map();
  uniquePlanEdges().forEach(edge=>rootTotals.set(edge.size,(rootTotals.get(edge.size)||0)+1));
  blocks.forEach(b=>{
    const count=floorCount(b),handrailSides=(b.outerProtection==="handrail"?1:0)+(b.innerProtection==="handrail"?1:0);workHandrails.set(b.span,(workHandrails.get(b.span)||0)+count*2*handrailSides);
    const boardWidths=b.width<=610?[490]:b.width<=914?[490,240]:[490,490];
    boardWidths.forEach(boardWidth=>{const key=b.span+"×"+boardWidth;deckTotals.set(key,(deckTotals.get(key)||0)+count)});
  });
  const group=(name,detail="")=>[name,detail,0,"","group"],rows=[group("支柱","支柱位置 "+postCount+"箇所"),...verticalBreakdown(posts),group("根がらみ材")];
  [...rootTotals].sort((a,b)=>b[0]-a[0]).forEach(([size,count])=>rows.push(["IQ手すり "+size,"平面外周（接続部重複なし）",count,"本"]));
  rows.push(group("作業床材"));
  [...workHandrails].sort((a,b)=>b[0]-a[0]).forEach(([size,count])=>rows.push(["IQ手すり "+size,"各作業床450/900・内外側",count,"本"]));
  [...deckTotals].sort((a,b)=>b[0].localeCompare(a[0],"ja",{numeric:true})).forEach(([size,count])=>rows.push(["布板 "+size,"Sウォーク",count,"枚"]));
  const stairCount=blocks.reduce((sum,b)=>sum+(b.hasStair&&b.span===1829?Math.max(0,floorCount(b)-1):0),0);
  rows.push(group("昇降"),["階段 1900","IQアルミカイダン19",stairCount,"基"],["階段手すり","IQカイダンレール",stairCount,"本"]);return rows;
}
function updateDefaultHeightPreview(){
  defaultFL=Number($("defaultFL").value||0);defaultBaseHeight=Number($("defaultBaseHeight").value||0);defaultFloorCount=Math.max(1,Math.round(Number($("defaultFloorCount").value)||1));
  $("defaultFloorCount").value=defaultFloorCount;const first=Math.max(0,defaultFL-defaultBaseHeight),upperLevel=defaultFL+(defaultFloorCount-1)*1900+900;
  $("defaultActualHeight").textContent="FL "+upperLevel.toLocaleString()+" mm";$("addMode").disabled=first<=0;saveLocal();
}
function applyDefaultLevelToAll(){
  const first=defaultFL-defaultBaseHeight;if(!blocks.length||first<=0)return;
  commit(blocks.map(b=>({...b,firstFloorFL:defaultFL,floorCount:defaultFloorCount,baseHeight:defaultBaseHeight})));updateSelectionEditor();status(blocks.length+"件すべてに作業床設定を反映しました");
}
function handleDefaultLevelInput(){
  updateDefaultHeightPreview();clearTimeout(levelApplyTimer);levelApplyTimer=setTimeout(applyDefaultLevelToAll,250);
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
$("placeStair").onchange=e=>{placementStair=e.target.checked;if(placementStair){const target=document.querySelector('[data-span="1829"]');target?.click();$("addMode").textContent="＋ 階段付き足場を配置"}else $("addMode").textContent="＋ 図面をクリックして配置"};
$("defaultFL").oninput=handleDefaultLevelInput;$("defaultBaseHeight").oninput=handleDefaultLevelInput;$("defaultFloorCount").oninput=handleDefaultLevelInput;
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
  const firstHeight=defaultFL-defaultBaseHeight;if(firstHeight<=0){status("1段目作業床FLは設置面高さより大きくしてください");return}
  if(placementStair&&(span!==1829||defaultFloorCount<2)){status("階段は1829スパン・作業床2層以上で配置してください");return}
  const w=span/mmPerPx,d=width/mmPerPx,raw={id:uid(),x:Math.max(0,p.x-w/2),y:Math.max(0,p.y-d/2),span,width,firstFloorFL:defaultFL,floorCount:defaultFloorCount,baseHeight:defaultBaseHeight,rotation:0,outerProtection:"handrail",innerProtection:"handrail",hasStair:placementStair};
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
$("selectedFL").onchange=e=>applyElevationChange("firstFloorFL",e.target.value);
$("selectedBaseHeight").onchange=e=>applyElevationChange("baseHeight",e.target.value);
$("selectedFloorCount").onchange=e=>applyElevationChange("floorCount",Math.max(1,Math.round(Number(e.target.value)||1)));
$("toggleStair").onclick=()=>{const selected=selectedBlocks();if(!selected.length||!selected.every(b=>b.span===1829&&floorCountOf(b)>1))return;const remove=selected.every(b=>b.hasStair);commit(blocks.map(b=>selectedIds.has(b.id)?{...b,hasStair:!remove}:b));updateSelectionEditor();status(remove?selected.length+"件の階段を解除しました":selected.length+"件を階段付き足場に変更しました")};
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
$("saveProject").onclick=()=>{download("足場拾いデータ.json",JSON.stringify({version:3,blocks,mmPerPx,drawingScale,savedAt:new Date().toISOString()},null,2),"application/json");status("作業データを保存しました")};
$("projectInput").onchange=async e=>{try{const data=JSON.parse(await e.target.files[0].text());if(!Array.isArray(data.blocks))throw new Error();history=[...history,structuredClone(blocks)];blocks=data.blocks.map(normalizeBlock);mmPerPx=data.mmPerPx||mmPerPx;drawingScale=data.drawingScale||drawingScale;$("drawingScale").value=drawingScale;selectBlocks([]);saveLocal();renderBlocks();updateSummary();status("作業データを読み込みました")}catch{status("作業データを読み込めませんでした")}};
$("csv").onclick=()=>{const rows=[["部材名","規格・条件","数量","単位"],...quantities().map(r=>r[4]==="group"?[r[0],r[1],"",""]:r.slice(0,4))],csv="\ufeff"+rows.map(r=>r.map(v=>'"'+String(v).replaceAll('"','""')+'"').join(",")).join("\r\n");download("足場概算数量.csv",csv,"text/csv;charset=utf-8")};
$("print").onclick=()=>window.print();

try{
  const data=JSON.parse(localStorage.getItem(KEY)||"{}");
  if(Array.isArray(data.blocks))blocks=data.blocks.map(normalizeBlock);if(data.mmPerPx)mmPerPx=data.mmPerPx;
  if(data.drawingScale){drawingScale=data.drawingScale;$("drawingScale").value=drawingScale}
  if(data.workFloorBasisV2===true&&Number.isFinite(data.defaultFL)){defaultFL=data.defaultFL;$("defaultFL").value=defaultFL}else{$("defaultFL").value=defaultFL}
  if(Number.isFinite(data.defaultBaseHeight)){defaultBaseHeight=data.defaultBaseHeight;$("defaultBaseHeight").value=defaultBaseHeight}
  if(data.workFloorBasisV2===true&&Number.isFinite(data.defaultFloorCount)){defaultFloorCount=Math.max(1,Math.round(data.defaultFloorCount));$("defaultFloorCount").value=defaultFloorCount}
  if(data.workFloorBasisV2!==true)blocks=blocks.map(b=>normalizeBlock({...b,firstFloorFL:Number(b.baseHeight||0)+700,floorCount:1}));
  if(typeof data.panelCollapsed==="boolean")panelCollapsed=data.panelCollapsed;if(blocks.length)status("前回の配置データを復元しました");
}catch{localStorage.removeItem(KEY)}
updateDefaultHeightPreview();applyPanelState();setStageSize();renderBlocks();updateSummary();updateSelectionEditor();status($("status").textContent);
