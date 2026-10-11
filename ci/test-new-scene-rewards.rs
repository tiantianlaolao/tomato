#[cfg(test)]
mod new_scene_rewards {
    use crate::rewards as r;
    fn dir(name: &str) -> std::path::PathBuf {
        let stamp=std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
        let p=std::env::temp_dir().join(format!("capy_scene_{name}_{}_{stamp}",std::process::id()));
        std::fs::create_dir_all(&p).unwrap();p
    }
    #[test]
    fn new_themes_persist_separately_and_survive_snapshot_merge() {
        let p=dir("source");
        for theme in ["snow","glasshouse"] {r::grant_all(&p,theme,1000).unwrap();}
        r::place(&p,"snow","moon-stone","moon-stone",2000).unwrap();
        r::hang(&p,"snow","st08",2001).unwrap();
        r::place(&p,"glasshouse","table_cup","mug",2002).unwrap();
        r::hang(&p,"glasshouse","t02",2003).unwrap();
        assert!(r::place(&p,"glasshouse","table_cup","moon-stone",2004).is_err());
        assert!(r::hang(&p,"snow","t02",2004).is_err());
        let (snapshot,mtime)=r::snapshot_json(&p);let q=dir("target");
        assert!(r::merge_remote(&q,&snapshot,mtime,3000));
        assert_eq!(r::view(&q,"snow",3001).state.hung,"st08");
        assert_eq!(r::view(&q,"glasshouse",3001).state.hung,"t02");
        assert_eq!(r::view(&q,"snow",3001).state.placed["moon-stone"],"moon-stone");
        assert_eq!(r::view(&q,"glasshouse",3001).state.placed["table_cup"],"mug");
        assert!(r::view(&q,"ink",3001).state.props.is_empty());
    }
    #[test]
    fn internal_revoke_preserves_earned_gifts_and_old_real_purchase() {
        let p=dir("revoke");
        r::unlock(&p,"snow","towel","st01","earn",1000).unwrap();
        r::unlock(&p,"glasshouse","towel","t01","earn",1001).unwrap();
        r::purchase(&p,"onsen","theme","onsen","existing-real-transaction",1002).unwrap();
        for theme in ["snow","glasshouse"] {r::grant_all(&p,theme,2000).unwrap();}
        r::revoke_internal(&p,"snow",3000).unwrap();
        for (theme,gift) in [("snow","st01"),("glasshouse","t01")] {
            let v=r::view(&p,theme,3001);assert_eq!(v.state.towels,vec![gift]);
            assert!(v.state.props.is_empty());assert!(!v.owned_themes.contains(&theme.to_string()));
            assert!(v.owned_themes.contains(&"onsen".to_string()));
        }
    }
}
