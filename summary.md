
기능 보완사항 (한전)
일단 한전부터 구현할거야 지금 로그인, 공인인증서 인증까지 기능 구현은 완료 됐어 즉 최종로그인 까지는 구현완료.

이제 참가신청 기능을 구현해야하는데 내가 지난번에 기능 구현하다가 문제가 생겨서 멈췄거든? 먼저 kepco.js 파일을 확인해줘
로그인을하고

<a class="x-btn x-unselectable x-box-item x-toolbar-item x-btn-mdi-top-menu-button-small" style="height: 60px; right: auto; left: 104px; top: 0px; margin: 0px;" role="button" id="button-1114" tabindex="0" componentid="button-1114"><span id="button-1114-btnWrap" data-ref="btnWrap" role="presentation" unselectable="on" style="" class="x-btn-wrap x-btn-wrap-mdi-top-menu-button-small "><span id="button-1114-btnEl" data-ref="btnEl" role="presentation" unselectable="on" style="height:auto;" class="x-btn-button x-btn-button-mdi-top-menu-button-small x-btn-text    x-btn-button-center "><span id="button-1114-btnIconEl" data-ref="btnIconEl" role="presentation" unselectable="on" class="x-btn-icon-el x-btn-icon-el-mdi-top-menu-button-small  " style=""></span><span id="button-1114-btnInnerEl" data-ref="btnInnerEl" unselectable="on" class="x-btn-inner x-btn-inner-mdi-top-menu-button-small">입찰/계약</span></span></span></a>

첫번째로 상단 메뉴바인 입찰/계약 버튼을 누르고

<div unselectable="on" class="x-grid-cell-inner x-grid-cell-inner-treecolumn" style="text-align:left;" id="ext-element-55"><img src="data:image/gif;base64,R0lGODlhAQABAID/AMDAwAAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==" class=" x-tree-elbow-img x-tree-elbow" role="presentation" alt=""><img src="data:image/gif;base64,R0lGODlhAQABAID/AMDAwAAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==" role="presentation" class=" x-tree-icon x-tree-icon-leaf " alt=""><span class="x-tree-node-text " id="ext-element-56"> <h4 style="display:inline;font-size:12px;"> 입찰참가신청 </h4> </span></div>

그 다음 입찰참가신청 버튼까지 누르는거부터 구현을 해줘 지금 코드가 문제가있는데 너가 수정하면서 구현해줘

한가지 중요사항은 ID값 1141, 또는 55번과같은건 브라우저가 새로 켜질대마다 값이 바뀌더라고 이건 쓰면 안될거같아