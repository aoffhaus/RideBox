/**
 * Bookmarklet: run on a trainerroad.com workout page while logged in. It fetches
 * the workout JSON that TrainerRoad's own page uses (/api/workoutdetails/<id>)
 * and copies it to the clipboard so you can paste it into RideBox → Workouts.
 *
 * Clipboard writes need the click's user activation, which can expire while the
 * fetch runs (Safari is strict about this). So it starts the clipboard write
 * synchronously with a ClipboardItem whose content is a promise, falls back to
 * writeText after the fetch, and as a last resort downloads the JSON file.
 *
 * This endpoint is undocumented (the open-source "trzwo" Chrome extension uses
 * the same one), so it may stop working if TrainerRoad changes its site.
 */
const source = `(function(){
var m=location.pathname.match(/workouts\\/(\\d+)/)||location.href.match(/\\/(\\d+)[^/]*$/);
if(!/trainerroad\\.com$/.test(location.hostname)||!m){alert('RideBox: open a workout page on trainerroad.com first (e.g. trainerroad.com/app/cycling/workouts/12345-name), then click this bookmark.');return}
var get=(async function(){
var r=await fetch('/api/workoutdetails/'+m[1],{credentials:'include'});
if(!r.ok)r=await fetch('/app/api/workoutdetails/'+m[1],{credentials:'include'});
if(!r.ok)throw new Error('HTTP '+r.status+' (are you logged in?)');
var j=await r.json();
return{text:JSON.stringify(j),name:((j.Workout&&j.Workout.Details&&j.Workout.Details.WorkoutName)||('workout-'+m[1])).trim()}})();
var copy=Promise.reject();
try{copy=navigator.clipboard.write([new ClipboardItem({'text/plain':get.then(function(d){return new Blob([d.text],{type:'text/plain'})})})])}catch(e){}
copy.catch(function(){return get.then(function(d){return navigator.clipboard.writeText(d.text)})})
.then(function(){return get.then(function(d){alert('RideBox: copied "'+d.name+'" to the clipboard. Paste it into the box on the RideBox Workouts tab.')})},
function(){return get.then(function(d){
var a=document.createElement('a');
a.href=URL.createObjectURL(new Blob([d.text],{type:'application/json'}));
a.download='TR - '+d.name.replace(/[^\\w -]+/g,'')+'.json';
document.body.appendChild(a);a.click();a.remove();
alert('RideBox: your browser blocked clipboard access, so the workout was downloaded as a file instead. Drop it on the RideBox Workouts tab.')})})
.catch(function(e){alert('RideBox: could not fetch the workout: '+(e&&e.message||e))});
})()`;

export const BOOKMARKLET = 'javascript:' + encodeURIComponent(source.replace(/\n/g, ''));
