/**
 * Bookmarklet: run on a trainerroad.com workout page while logged in. It fetches
 * the workout JSON that TrainerRoad's own page uses (/api/workoutdetails/<id>)
 * and downloads it so you can drop it into RideBox → Workouts.
 *
 * This endpoint is undocumented (the open-source "trzwo" Chrome extension uses
 * the same one), so it may stop working if TrainerRoad changes its site.
 */
const source = `(async()=>{try{
var m=location.pathname.match(/workouts\\/(\\d+)/)||location.href.match(/\\/(\\d+)[^/]*$/);
if(!/trainerroad\\.com$/.test(location.hostname)||!m){alert('RideBox: open a workout page on trainerroad.com first (e.g. trainerroad.com/app/cycling/workouts/12345-name), then click this bookmark.');return}
var r=await fetch('/api/workoutdetails/'+m[1],{credentials:'include'});
if(!r.ok)r=await fetch('/app/api/workoutdetails/'+m[1],{credentials:'include'});
if(!r.ok)throw new Error('HTTP '+r.status+' (are you logged in?)');
var j=await r.json();
var n=((j.Workout&&j.Workout.Details&&j.Workout.Details.WorkoutName)||('workout-'+m[1])).trim();
var a=document.createElement('a');
a.href=URL.createObjectURL(new Blob([JSON.stringify(j)],{type:'application/json'}));
a.download='TR - '+n.replace(/[^\\w -]+/g,'')+'.json';
document.body.appendChild(a);a.click();a.remove();
}catch(e){alert('RideBox: could not fetch the workout: '+e.message)}})()`;

export const BOOKMARKLET = 'javascript:' + encodeURIComponent(source.replace(/\n/g, ''));
