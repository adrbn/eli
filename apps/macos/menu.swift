// Native menus, in French or English after the first preferred language. Most items ask the page through command().
import AppKit

extension AppDelegate {
    func command(_ name: String) { web.host("command", name) }

    // MARK: actions

    @objc func pick(_ sender: NSMenuItem) { (sender.representedObject as? String).flatMap(Placement.init).map(place) }
    @objc func settings() { place(.window); command("settings") }
    @objc func faces() { command("faces") }
    @objc func chat() { command("chat"); web.window?.makeFirstResponder(web) }
    @objc func playPause() { command("music") }
    @objc func stopTalking() { command("stop") }
    @objc func stopMusic() { command("stop-music") }
    @objc func previousSong() { command("prev") }
    @objc func nextSong() { command("next") }
    @objc func library() { place(.window); command("library") }
    @objc func copyReport() { command("report") }
    @objc func reload() { start() }
    @objc func openInBrowser() { NSWorkspace.shared.open(origin) }
    @objc func showLog() { NSWorkspace.shared.open(logURL) }
    @objc func showData() { NSWorkspace.shared.open(dataURL) }
    @objc func checkForUpdates() { updater?.checkForUpdates(nil) }
    @objc func openGitHub() { NSWorkspace.shared.open(URL(string: "https://github.com/adrbn/eli")!) }

    @objc func reportIssue() {
        command("report")  // the page copies its diagnostic: nothing goes in the URL
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) {  // let the copy land before the browser takes focus
            NSWorkspace.shared.open(URL(string: "https://github.com/adrbn/eli/issues/new?template=bug.yml")!)
        }
    }

    @objc func toggleDev() {
        let on = !defaults.bool(forKey: "dev")
        defaults.set(on, forKey: "dev")
        web.configuration.preferences.setValue(on, forKey: "developerExtrasEnabled")
        command("dev")
    }

    @objc func toggleAllSpaces() {
        let on = !defaults.bool(forKey: "widget.allSpaces")
        defaults.set(on, forKey: "widget.allSpaces")
        widget?.setAllSpaces(on)
    }

    @objc func chooseFolder() {
        guard chooseRepo() != nil else { return }
        stopServer()
        start()
    }

    func validateMenuItem(_ item: NSMenuItem) -> Bool {
        switch item.action {
        case #selector(pick): item.state = item.representedObject as? String == placement.rawValue ? .on : .off
        case #selector(toggleAllSpaces): item.state = defaults.bool(forKey: "widget.allSpaces") ? .on : .off
        case #selector(toggleDev): item.state = defaults.bool(forKey: "dev") ? .on : .off
        case #selector(playPause):
            guard let song else { return true }  // a page without the bridge: let it try
            let title = song.title.flatMap { $0.isEmpty ? nil : " — \($0)" } ?? ""
            item.title = !song.loaded ? L("Lecture/Pause", "Play/Pause") : (song.singing ? "Pause" : L("Reprendre", "Resume")) + title
            return song.loaded
        case #selector(stopMusic): return song?.loaded ?? true
        case #selector(checkForUpdates): return updater?.updater.canCheckForUpdates ?? false
        default: break
        }
        return true
    }

    // MARK: building

    func item(_ title: String, _ action: Selector, _ key: String = "", _ mods: NSEvent.ModifierFlags = .command,
              tag: String? = nil, mine: Bool = true) -> NSMenuItem {
        let item = NSMenuItem(title: title, action: action, keyEquivalent: key)
        item.keyEquivalentModifierMask = mods
        item.representedObject = tag
        if mine { item.target = self }
        return item
    }

    /// AppKit's own actions, sent down the responder chain.
    func std(_ title: String, _ action: Selector, _ key: String = "", _ mods: NSEvent.ModifierFlags = .command) -> NSMenuItem {
        item(title, action, key, mods, mine: false)
    }

    func menu(_ title: String, _ items: [NSMenuItem]) -> NSMenu {
        let menu = NSMenu(title: title)
        items.forEach(menu.addItem)
        return menu
    }

    func placementItems() -> [NSMenuItem] {
        [item(L("Fenêtre", "Window"), #selector(pick), "1", tag: Placement.window.rawValue),
         item(L("Flottant", "Floating"), #selector(pick), "2", tag: Placement.widget.rawValue),
         item(L("Encoche", "Notch"), #selector(pick), "3", tag: Placement.notch.rawValue)]
    }

    func settingsItem() -> NSMenuItem { item(L("Réglages…", "Settings…"), #selector(settings), ",") }
    func quitItem() -> NSMenuItem { std(L("Quitter Eli", "Quit Eli"), #selector(NSApplication.terminate(_:)), "q") }

    /// Right-click on the widget or the notch.
    func contextMenu() -> NSMenu { menu("Eli", placementItems() + [.separator(), settingsItem(), .separator(), quitItem()]) }

    func mainMenu() -> NSMenu {
        let windowMenu = menu(L("Fenêtre", "Window"), [
            std(L("Réduire", "Minimize"), #selector(NSWindow.performMiniaturize(_:)), "m"),
            std(L("Fermer", "Close"), #selector(NSWindow.performClose(_:)), "w"),
        ])
        let helpMenu = menu(L("Aide", "Help"), [
            item(L("Signaler un problème…", "Report a Problem…"), #selector(reportIssue)),
            item(L("Eli sur GitHub", "Eli on GitHub"), #selector(openGitHub)),
        ])
        NSApp.windowsMenu = windowMenu
        NSApp.helpMenu = helpMenu
        let bar = menu("", [])
        for sub in [
            menu("Eli", [
                std(L("À propos d’Eli", "About Eli"), #selector(NSApplication.orderFrontStandardAboutPanel(_:))),
                item(L("Rechercher les mises à jour…", "Check for Updates…"), #selector(checkForUpdates)),
                .separator(),
                settingsItem(),
                .separator(),
                std(L("Masquer Eli", "Hide Eli"), #selector(NSApplication.hide(_:)), "h"),
                std(L("Masquer les autres", "Hide Others"), #selector(NSApplication.hideOtherApplications(_:)), "h", [.command, .option]),
                std(L("Tout afficher", "Show All"), #selector(NSApplication.unhideAllApplications(_:))),
                .separator(),
                quitItem(),
            ]),
            menu(L("Édition", "Edit"), [  // without it, ⌘C/⌘V do nothing in the page's text field
                std(L("Annuler", "Undo"), Selector(("undo:")), "z"),
                std(L("Rétablir", "Redo"), Selector(("redo:")), "z", [.command, .shift]),
                .separator(),
                std(L("Couper", "Cut"), #selector(NSText.cut(_:)), "x"),
                std(L("Copier", "Copy"), #selector(NSText.copy(_:)), "c"),
                std(L("Coller", "Paste"), #selector(NSText.paste(_:)), "v"),
                std(L("Tout sélectionner", "Select All"), #selector(NSText.selectAll(_:)), "a"),
            ]),
            menu(L("Présentation", "View"), placementItems() + [
                .separator(),
                item(L("Flottant sur tous les bureaux", "Float on All Desktops"), #selector(toggleAllSpaces)),
                .separator(),
                item(L("Visages…", "Faces…"), #selector(faces), "v", [.command, .shift]),
                item(L("Écrire à Eli", "Write to Eli"), #selector(chat), "l"),
                .separator(),
                std(L("Plein écran", "Enter Full Screen"), #selector(NSWindow.toggleFullScreen(_:)), "f", [.command, .control]),
            ]),
            menu(L("Musique", "Music"), [
                item(L("Bibliothèque…", "Library…"), #selector(library), "b"),
                .separator(),
                item(L("Lecture/Pause", "Play/Pause"), #selector(playPause), "p"),
                item(L("Morceau précédent", "Previous Song"), #selector(previousSong)),
                item(L("Morceau suivant", "Next Song"), #selector(nextSong)),
                item(L("Arrêter le morceau", "Stop the Song"), #selector(stopMusic)),
                item(L("Couper la parole", "Stop Talking"), #selector(stopTalking), "."),
            ]),
            menu(L("Développeur", "Developer"), [
                item(L("Mode développeur", "Developer Mode"), #selector(toggleDev)),
                item(L("Copier le diagnostic", "Copy Diagnostics"), #selector(copyReport), "d", [.command, .option]),
                item(L("Journal du serveur", "Server Log"), #selector(showLog), "l", [.command, .shift]),
                item(L("Ouvrir dans le navigateur", "Open in Browser"), #selector(openInBrowser), "o", [.command, .shift]),
                item(L("Recharger", "Reload"), #selector(reload), "r"),
            ] + (bundled == nil ? [item(L("Choisir le dossier Eli…", "Choose Eli Folder…"), #selector(chooseFolder))]
                                : [item(L("Dossier des données", "Data Folder"), #selector(showData))])),
            windowMenu,
            helpMenu,
        ] {
            let holder = NSMenuItem(title: sub.title, action: nil, keyEquivalent: "")
            holder.submenu = sub
            bar.addItem(holder)
        }
        return bar
    }
}
